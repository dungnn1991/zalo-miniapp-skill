#!/usr/bin/env node
// build.mjs — vite build + dist artifact assertions + APP_ID build-process check (Subagent C).
// Exit codes: 0 pass · 1 build/artifact/app-id gate failed (finding recorded) · 3 precondition error.
// Also importable (main-guarded): verify.mjs reuses the finding texts + failure classifier.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';
import { recordFinding } from './record-finding.mjs';
import {
  appendPreflight, readSrcTexts, scanAssetPaths, scanServerSideApi, scanSizeLimit,
  EXPECTED_SERVER_SIDE_API, EXPECTED_SIZE_LIMIT, matchSignatures,
} from './insight.mjs';

// Shared finding texts — verify.mjs reconstructs the same strings so the
// fingerprint dedupe merges its gate findings into the ones recorded here.
export const EXPECTED_BUILD = 'vite build exits 0 and writes dist artifacts';
export const actualBuild = (code) => `vite build exited ${code}`;
export const EXPECTED_BUILD_CSS = 'pnpm run build:css exits 0 (official template pre-build)';
export const actualBuildCss = (code) => `build:css exited ${code}`;
export const EXPECTED_ARTIFACTS = 'build outDir contains index.html and at least one .js asset';

// Phase 2.5: official templates (vite root ./src, zmp-vite-plugin default www) may emit their
// build elsewhere than the lab template's dist. Newest index.html wins; lab stays "dist".
export const OUT_DIR_CANDIDATES = ['dist', 'www', 'src/www', 'src/dist'];

// Official templates ship index.html at the app ROOT (the `zmp start`/`zmp deploy` flow wires
// it up internally), so a direct `vite build` with root "./src" finds no entry. Narrow prep:
// only when the vite config pins root to ./src AND src/index.html is absent AND a root
// index.html exists — generate src/index.html with root-absolute "/src/..." refs rewritten to
// "./...". Lab template (vite root default ".") is never touched. Observed on zaui-fashion
// (vite.config.mts) 2026-08-20; verified: build then emits src/www/.
export function prepareViteSrcEntry(appDir) {
  const cfgFile = ['vite.config.mts', 'vite.config.ts', 'vite.config.mjs', 'vite.config.js']
    .map((f) => path.join(appDir, f))
    .find((f) => fs.existsSync(f));
  if (!cfgFile) return false;
  if (!/root:\s*['"]\.?\/?src\/?['"]/.test(fs.readFileSync(cfgFile, 'utf8'))) return false;
  const srcIndex = path.join(appDir, 'src', 'index.html');
  const rootIndex = path.join(appDir, 'index.html');
  if (fs.existsSync(srcIndex) || !fs.existsSync(rootIndex)) return false;
  fs.writeFileSync(srcIndex, fs.readFileSync(rootIndex, 'utf8').replaceAll('"/src/', '"./'));
  return true;
}
export function detectOutDir(appDir) {
  let outDir = null;
  let newest = -1;
  for (const cand of OUT_DIR_CANDIDATES) {
    const f = path.join(appDir, cand, 'index.html');
    if (!fs.existsSync(f)) continue;
    const m = fs.statSync(f).mtimeMs;
    if (m > newest) { newest = m; outDir = cand; }
  }
  return outDir;
}
export const EXPECTED_APP_ID = 'build process resolves APP_ID equal to expectedAppId (app_id_not_persisted)';
export const actualAppId = (expected, got) => `expectedAppId=${expected} buildProcessAppId=${got}`;

// A build failure is a dependency problem when the log shows unresolved modules;
// anything else is the app's own code. Same classifier used by verify.mjs.
export function classifyBuildFailure(logText) {
  return /(cannot find module|failed to resolve import|could not resolve|module not found|err_module_not_found)/i.test(logText || '')
    ? 'dependency'
    : 'app';
}

export function distHasJsAsset(distDir) {
  if (!fs.existsSync(distDir)) return false;
  const stack = [distDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) return true;
    }
  }
  return false;
}

// Ask the build toolchain itself (vite loadEnv from the app root) which APP_ID it sees —
// existence of .env is not enough, per plan §5.2.
const LOAD_ENV_SNIPPET =
  "const {loadEnv}=await import('vite'); console.log(JSON.stringify({APP_ID: loadEnv('production', process.cwd(), '').APP_ID ?? null}))";

function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  if (!runId) {
    console.error('build: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`build: run dir not found: ${runDir} — run bootstrap first`);
    process.exit(3);
  }
  if (!fs.existsSync(path.join(ws.appDir, 'package.json'))) {
    console.error(`build: ${path.join(ws.appDir, 'package.json')} missing — run bootstrap first`);
    process.exit(3);
  }

  const ctx = openRun(ws.runsDir, runId);
  const binding = ctx.readJson('evidence/app-id-binding.json');
  if (!binding || typeof binding.expectedAppId !== 'string') {
    console.error('build: evidence/app-id-binding.json missing or has no expectedAppId — bootstrap contract broken');
    process.exit(3);
  }

  // Phase 2.6 Tier-1 preflight on src/ BEFORE building (plan 29 §2.1).
  const srcTexts = readSrcTexts(ws.appDir);
  // server_side_api_scan (FAQ 22) — security hole, hard fail before any build work.
  const apiScan = appendPreflight(ctx, scanServerSideApi(srcTexts));
  ctx.event('preflight', { stage: 'build', gateId: 'server_side_api_scan', status: apiScan.status, detail: apiScan.detail });
  if (apiScan.status === 'fail') {
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'build', category: 'app', severity: 'blocking',
      expected: EXPECTED_SERVER_SIDE_API,
      actual: apiScan.detail,
      evidence: ['evidence/preflight.json'],
      insight: apiScan.insight,
    });
    console.error(`build: server_side_api_scan failed — ${apiScan.detail} — finding ${finding.findingId}`);
    process.exit(1);
  }
  // asset_path_scan (FAQ 23) — warn only, run continues.
  const assetScan = appendPreflight(ctx, scanAssetPaths(srcTexts));
  ctx.event('preflight', { stage: 'build', gateId: 'asset_path_scan', status: assetScan.status, detail: assetScan.detail });

  // Phase 2.5: official templates may carry a build:css script (postcss/tailwind generating
  // styles.css) that must run BEFORE vite build. Lab template has none — path unchanged.
  let cssLog = '';
  const appPkg = JSON.parse(fs.readFileSync(path.join(ws.appDir, 'package.json'), 'utf8'));
  if (appPkg.scripts?.['build:css']) {
    const tCss = Date.now();
    ctx.event('build', { stage: 'build', status: 'start', command: 'pnpm run build:css' });
    const cres = spawnSync('pnpm', ['run', 'build:css'], {
      cwd: ws.appDir,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (cres.error) {
      console.error(`build: cannot spawn pnpm: ${cres.error.message}`);
      process.exit(3);
    }
    const cssCode = cres.status ?? 1;
    cssLog = `=== pnpm run build:css (exit ${cssCode}) ===\n${cres.stdout || ''}\n${cres.stderr || ''}\n=== pnpm exec vite build ===\n`;
    ctx.event('build', {
      stage: 'build',
      status: cssCode === 0 ? 'css_ok' : 'css_fail',
      exitCode: cssCode,
      durationMs: Date.now() - tCss,
    });
    if (cssCode !== 0) {
      // Non-blocking, finding recorded (no silent workaround): zaui templates ship a stale
      // build:css (input file absent — tailwind actually runs inside the vite pipeline via
      // postcss.config.js). vite build below decides the real build outcome; category
      // dependency routes the stale script to the upstream template owner.
      const finding = recordFinding({
        workspace: ws.root, runId, runDir,
        stage: 'build',
        category: 'dependency',
        severity: 'major',
        expected: EXPECTED_BUILD_CSS,
        actual: actualBuildCss(cssCode),
        evidence: ['evidence/build.log'],
      });
      console.error(`build: build:css failed (exit ${cssCode}) — finding ${finding.findingId}, continuing (vite build decides)`);
    }
  }

  // Phase 2.5: official-template vite entry preparation (see prepareViteSrcEntry above).
  if (prepareViteSrcEntry(ws.appDir)) {
    ctx.event('build', {
      stage: 'build',
      status: 'vite_entry_prepared',
      detail: 'src/index.html generated from root index.html with refs rewritten (vite root ./src)',
    });
    recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'build',
      category: 'dependency',
      severity: 'minor',
      expected: 'official template builds with plain vite build without harness preparation',
      actual: 'vite root ./src but index.html only at app root — harness generated src/index.html with rewritten refs',
      evidence: ['events.jsonl'],
    });
  }

  const t0 = Date.now();
  ctx.event('build', { stage: 'build', status: 'start', command: 'pnpm exec vite build' });

  const res = spawnSync('pnpm', ['exec', 'vite', 'build'], {
    cwd: ws.appDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`build: cannot spawn pnpm: ${res.error.message}`);
    process.exit(3);
  }
  const exitCode = res.status ?? 1;
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  ctx.writeTextEvidence('evidence/build.log', (cssLog + output).split('\n').slice(-800).join('\n'));
  ctx.event('build', {
    stage: 'build',
    status: exitCode === 0 ? 'ok' : 'fail',
    exitCode,
    durationMs: Date.now() - t0,
  });

  if (exitCode !== 0) {
    // Tier-2: attach a diagnosis when the log matches the curated error-signature map.
    const sig = matchSignatures(cssLog + output, 'build')[0] ?? null;
    const finding = recordFinding({
      workspace: ws.root,
      runId,
      runDir,
      stage: 'build',
      category: classifyBuildFailure(output),
      severity: 'blocking',
      expected: EXPECTED_BUILD,
      actual: actualBuild(exitCode),
      evidence: ['evidence/build.log'],
      insight: sig,
    });
    console.error(`build: vite build failed (exit ${exitCode}) — finding ${finding.findingId}`);
    process.exit(1);
  }

  // Artifact assertions + outDir detection (Phase 2.5). Lab template must keep yielding "dist".
  const outDir = detectOutDir(ws.appDir);
  const missing = [];
  if (!outDir) missing.push(`index.html in any of ${OUT_DIR_CANDIDATES.join(' | ')}`);
  else if (!distHasJsAsset(path.join(ws.appDir, outDir))) missing.push(`${outDir}/**/*.js`);
  if (missing.length) {
    const finding = recordFinding({
      workspace: ws.root,
      runId,
      runDir,
      stage: 'build',
      category: 'app',
      severity: 'blocking',
      expected: EXPECTED_ARTIFACTS,
      actual: `missing after successful build: ${missing.join(', ')}`,
      evidence: ['evidence/build.log'],
    });
    console.error(`build: artifacts missing (${missing.join(', ')}) — finding ${finding.findingId}`);
    process.exit(1);
  }
  // render.mjs serves and deploy.mjs uploads whatever outDir the build actually produced.
  ctx.writeJson('evidence/build-info.json', { outDir, builtAt: new Date().toISOString() });
  ctx.event('build', { stage: 'build', status: 'outdir_detected', detail: outDir, path: outDir });

  // size_limit (FAQ 24) — measured on the real build output; over limit = certain deploy fail.
  const sizeScan = appendPreflight(ctx, scanSizeLimit(path.join(ws.appDir, outDir)));
  ctx.event('preflight', { stage: 'build', gateId: 'size_limit', status: sizeScan.status, detail: sizeScan.detail });
  if (sizeScan.status === 'fail') {
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'build', category: 'app', severity: 'blocking',
      expected: EXPECTED_SIZE_LIMIT,
      actual: sizeScan.detail,
      evidence: ['evidence/preflight.json'],
      insight: sizeScan.insight,
    });
    console.error(`build: size_limit failed — ${sizeScan.detail} — finding ${finding.findingId}`);
    process.exit(1);
  }

  // APP_ID build-process check (vite resolved from app/node_modules, cwd = app root).
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', LOAD_ENV_SNIPPET], {
    cwd: ws.appDir,
    encoding: 'utf8',
  });
  let buildProcessAppId = null;
  if (probe.status === 0) {
    try {
      const lines = String(probe.stdout || '').trim().split('\n').filter(Boolean);
      buildProcessAppId = JSON.parse(lines[lines.length - 1]).APP_ID ?? null;
    } catch {
      buildProcessAppId = null;
    }
  }

  // Read-modify-write the shared binding evidence with the build-process view.
  binding.buildProcessAppId = buildProcessAppId;
  ctx.writeJson('evidence/app-id-binding.json', binding);
  const bound = buildProcessAppId !== null && buildProcessAppId === binding.expectedAppId;
  ctx.event('app_id_check', {
    stage: 'build',
    status: bound ? 'ok' : 'fail',
    detail: actualAppId(binding.expectedAppId, buildProcessAppId),
  });

  if (!bound) {
    const finding = recordFinding({
      workspace: ws.root,
      runId,
      runDir,
      stage: 'build',
      category: 'skill',
      severity: 'blocking',
      expected: EXPECTED_APP_ID,
      actual: actualAppId(binding.expectedAppId, buildProcessAppId),
      evidence: ['evidence/app-id-binding.json', 'evidence/build.log'],
    });
    console.error(`build: app_id_not_persisted (expected=${binding.expectedAppId} got=${buildProcessAppId}) — finding ${finding.findingId}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ runId, stage: 'build', status: 'ok' }));
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) main();
