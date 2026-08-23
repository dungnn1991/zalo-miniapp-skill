#!/usr/bin/env node
// render.mjs — serve app/dist on an ephemeral port and drive the LOCKED browser runner (Subagent C).
// The runner writes console.jsonl / dom.json / gates.json / *.png straight into runs/<id>/evidence/.
// No findings here — verify.mjs owns turning failed gates into findings.
// Exit codes mirror the runner: 0 all gates pass · 1 ≥1 gate failed · 3 precondition/runner error.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg, RUNNER_PATH, CONFIG_PATH } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// Host URL contract (README, official templates): ZMPRouter's production basename is
// `zapps/${window.APP_ID}`, so the harness must serve under /zapps/<appId>/ and define
// window.APP_ID at serve time — otherwise the router matches nothing and renders blank
// (finding_2e7f7967bf09). pathPrefix strips the prefix before file mapping (un-prefixed
// requests still work — double safety); injectAppId injects the script IN-MEMORY into every
// served index.html (SPA fallback included) right before the first module script, or right
// after <head> when none is found. The built file on disk is never modified.
export function createStaticServer(distDir, { pathPrefix = null, injectAppId = null } = {}) {
  const indexHtml = path.join(distDir, 'index.html');
  const serveIndex = (res) => {
    let html = fs.readFileSync(indexHtml, 'utf8');
    if (injectAppId !== null) {
      const tag = `<script>window.APP_ID=${JSON.stringify(injectAppId)}</script>`;
      const moduleScript = /<script[^>]*type=["']?module/i;
      if (moduleScript.test(html)) html = html.replace(moduleScript, (m) => `${tag}${m}`);
      else if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
      else html = tag + html;
    }
    res.writeHead(200, { 'content-type': MIME['.html'] });
    res.end(html);
  };
  return http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      if (pathPrefix && (urlPath === pathPrefix || urlPath.startsWith(`${pathPrefix}/`))) {
        urlPath = urlPath.slice(pathPrefix.length) || '/';
      }
      // Resolve inside dist and prefix-check — no directory traversal.
      const file = path.resolve(distDir, '.' + path.posix.normalize('/' + urlPath));
      if (file !== distDir && !file.startsWith(distDir + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory() || file === indexHtml) {
        serveIndex(res); // index + SPA fallback (200)
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
    }
  });
}

// Shared by render.mjs and preview.mjs (same owner): which dir to serve and under which
// host contract. Phase 2.5: outDir from build-info.json (fallback dist); official template
// → /zapps/<appId>/ prefix + window.APP_ID injection.
export function resolveServeContext(ctx, ws) {
  const outDir = ctx.readJson('evidence/build-info.json')?.outDir ?? 'dist';
  const distDir = path.join(ws.appDir, outDir);
  const input = ctx.readJson('input.json');
  const src = input?.template?.source;
  // 'existing' (app ngoài, không có scaffold manifest — bootstrap --existing) dùng chung
  // đường generic với official template: host URL contract + oracle profile không đòi lab
  // markers. Chỉ app scaffold từ LAB template (source 'lab' hoặc input cũ không có template)
  // mới chịu bộ 8 marker gates.
  const isOfficial = src === 'official' || src === 'existing';
  const appId = input?.miniAppId ?? null;
  return {
    outDir,
    distDir,
    isOfficial,
    appId,
    hostPrefix: isOfficial && appId ? `/zapps/${appId}` : null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  if (!runId) {
    console.error('render: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`render: run dir not found: ${runDir} — run bootstrap first`);
    process.exit(3);
  }
  const ctx = openRun(ws.runsDir, runId);
  const { distDir, isOfficial, appId, hostPrefix } = resolveServeContext(ctx, ws);
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error(`render: ${path.join(distDir, 'index.html')} missing — run build first`);
    process.exit(3);
  }

  // Phase 3 (plan 28): --provider simulator — no static server at all. The runner serves the
  // app via playwright route-interception at https://h5.zdn.vn/zapps/<appId>/ (isMp needs the
  // real hostname+path) using scripts/sim/intercept.mjs and the manifest written here.
  if (getArg(argv, 'provider') === 'simulator') {
    if (!appId) {
      console.error('render: --provider simulator requires input.json miniAppId');
      process.exit(3);
    }
    // Sim SERVING và sim DEMO-FLOW là hai thứ khác nhau (mandate 42 §3.3). Serving = host
    // interception + shim + runtime marker + bridge log, đúng cho mọi app. Demo-flow = tab
    // "Tài khoản" + marker api-btn-* của LAB template, official template không có.
    // Trước đây official bị chặn thẳng ở đây vì hai thứ đó bị gộp làm một, nên template chính
    // thức không bao giờ chạy được dưới môi trường thật sự của nó. Giờ chỉ chọn oracle profile
    // khác; guard cũ (finding_30d7006aeaa7) vẫn còn nguyên giá trị dưới dạng profile
    // simulator-official — nó không đòi marker của lab nên không rơi vào react_mount fail
    // khó hiểu.
    const simProfile = isOfficial ? 'simulator-official' : 'simulator';
    const { buildSimManifest } = await import('./sim/intercept.mjs');
    const decision = getArg(argv, 'sim-decision', 'accept');
    const manifest = buildSimManifest(ctx, ws, { decision });
    const manifestPath = ctx.writeJson('sim-serve-manifest.json', manifest);
    if (!Object.keys(manifest.simConfig.apis).length) {
      console.error('render: warning — references/sim-mock-data.json absent/empty; every API will answer unmocked');
    }
    const t0 = Date.now();
    ctx.event('render', {
      stage: 'render',
      status: 'runner_start',
      command: `node ${RUNNER_PATH} --out <evidence> --profile ${simProfile} --sim-manifest ${manifestPath}`,
      detail: `simDecision=${decision} profile=${simProfile}`,
    });
    const child2 = spawn(process.execPath, [
      RUNNER_PATH,
      '--out', path.join(runDir, 'evidence'),
      '--config', CONFIG_PATH,
      '--profile', simProfile,
      '--sim-manifest', manifestPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child2.stdout.on('data', (d) => { out += d; });
    child2.stderr.on('data', (d) => { out += d; });
    const onSig = () => { try { child2.kill('SIGTERM'); } catch { /* gone */ } process.exit(3); };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    const code = await new Promise((resolve) => { child2.on('close', (c) => resolve(c ?? 3)); });
    ctx.event('render', {
      stage: 'render',
      status: code === 0 ? 'ok' : 'fail',
      exitCode: code,
      durationMs: Date.now() - t0,
      detail: out.trim().slice(-500),
    });
    const simExit = code === 0 ? 0 : code === 1 ? 1 : 3;
    console.log(JSON.stringify({ runId, stage: 'render', status: simExit === 0 ? 'ok' : 'fail', exitCode: simExit, provider: 'simulator', profile: simProfile }));
    process.exit(simExit);
  }
  // Oracle profile from input.json template.source: official → official-template, else full.
  const profileArgs = isOfficial ? ['--profile', 'official-template'] : [];
  if (isOfficial && !appId) {
    console.error('render: input.json has template.source=official but no miniAppId — cannot honor host URL contract');
    process.exit(3);
  }
  const server = createStaticServer(distDir, {
    pathPrefix: hostPrefix,
    injectAppId: isOfficial ? appId : null,
  });
  let child = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { server.close(); } catch { /* already closed */ }
    try { if (child && child.exitCode === null) child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(3); });
  process.on('SIGTERM', () => { cleanup(); process.exit(3); });

  let exitCode = 3;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const url = hostPrefix ? `http://127.0.0.1:${port}${hostPrefix}/` : `http://127.0.0.1:${port}/`;
    ctx.event('render', { stage: 'render', status: 'server_start', url, path: distDir });

    const runnerPath = RUNNER_PATH;
    const evidenceDir = path.join(runDir, 'evidence');
    const t0 = Date.now();
    ctx.event('render', {
      stage: 'render',
      status: 'runner_start',
      command: `node ${runnerPath} --url ${url} --out ${evidenceDir}${profileArgs.length ? ` ${profileArgs.join(' ')}` : ''}`,
    });
    child = spawn(process.execPath, [
      runnerPath,
      '--url', url,
      '--out', evidenceDir,
      '--config', CONFIG_PATH,
      ...profileArgs,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let runnerOut = '';
    child.stdout.on('data', (d) => { runnerOut += d; });
    child.stderr.on('data', (d) => { runnerOut += d; });
    const code = await new Promise((resolve) => { child.on('close', (c) => resolve(c ?? 3)); });
    ctx.event('render', {
      stage: 'render',
      status: code === 0 ? 'ok' : 'fail',
      exitCode: code,
      durationMs: Date.now() - t0,
      detail: runnerOut.trim().slice(-500),
    });
    exitCode = code === 0 ? 0 : code === 1 ? 1 : 3;
  } catch (err) {
    console.error(`render: ${err.message}`);
    exitCode = 3;
  } finally {
    cleanup();
    ctx.event('render', { stage: 'render', status: 'server_stop', exitCode });
  }

  console.log(JSON.stringify({ runId, stage: 'render', status: exitCode === 0 ? 'ok' : 'fail', exitCode }));
  process.exit(exitCode);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) await main();
