#!/usr/bin/env node
// preview.mjs — serve the built app for a human look (Subagent C, plan 29 §3.2).
//
//   node preview.mjs --run-id <id> [--workspace <dir>] [--timeout <ms>] [--no-open]
//
// Reuses render.mjs's static server (same owner): outDir from build-info.json, and for
// official templates the same host URL contract (/zapps/<appId>/ + window.APP_ID injection).
// NO browser runner, NO gates — just a URL, opened in the macOS default browser (`open`),
// process stays alive until Ctrl+C (or --timeout for scripted use).
// Exit codes: 0 clean stop · 3 precondition error.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveWorkspace, getArg, loadLabConfig } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';
import { createStaticServer, resolveServeContext } from './render.mjs';

const argv = process.argv.slice(2);
const ws = resolveWorkspace(argv);
const runId = getArg(argv, 'run-id');
if (!runId) {
  console.error('preview: --run-id <id> is required');
  process.exit(3);
}
const runDir = path.join(ws.runsDir, runId);
if (!fs.existsSync(runDir)) {
  console.error(`preview: run dir not found: ${runDir}`);
  process.exit(3);
}
const ctx = openRun(ws.runsDir, runId);
const { distDir, isOfficial, appId, hostPrefix } = resolveServeContext(ctx, ws);
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`preview: ${path.join(distDir, 'index.html')} missing — run build first`);
  process.exit(3);
}
if (isOfficial && !appId) {
  console.error('preview: official template run without miniAppId — cannot honor host URL contract');
  process.exit(3);
}

// Phase 3 (plan 28): the simulator opens a HEADED Chrome window (playwright channel chrome —
// accepted deviation from "default browser") with the same route-interception + shim as the
// simulator runner. Default decision for preview is `manual` so the human sees the sheet.
//
// `--sim` forces it; otherwise the run's own input.json decides, exactly like render.mjs. A
// template that only renders inside a Zalo host (registry
// `qualification.runtime.requiresZaloHost`) would otherwise open a blank preview window and
// leave the user guessing.
const previewSim = argv.includes('--sim') || ctx.readJson('input.json')?.renderProvider === 'simulator';
if (previewSim) {
  if (!appId) {
    console.error('preview: simulator preview requires input.json miniAppId');
    process.exit(3);
  }
  const { chromium } = await import('playwright-core');
  const { setupSimContext, buildSimManifest, simUrl } = await import('./sim/intercept.mjs');
  const decision = getArg(argv, 'sim-decision', 'manual');
  const manifest = buildSimManifest(ctx, ws, { decision });
  const vp = loadLabConfig().defaults?.defaultViewport ?? { width: 390, height: 844 };
  // Same UA contract as the runner (config sdkHostContract.envDetection.platform).
  const SIM_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Zalo android/24112050';
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({
    viewport: vp, userAgent: SIM_UA, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
  });
  await setupSimContext(context, manifest);
  const page = await context.newPage();
  const url = simUrl(appId);
  ctx.event('preview', { stage: 'cleanup', status: 'sim_start', url, detail: `decision=${decision}` });
  console.log(JSON.stringify({ runId, stage: 'preview', url, sim: true, decision }));
  console.log('preview --sim: headed Chrome window — đóng cửa sổ hoặc Ctrl+C để dừng');
  await page.goto(url).catch((err) => console.error(`preview: ${err.message}`));
  const closed = new Promise((resolve) => browser.on('disconnected', resolve));
  const stopSim = async () => { try { await browser.close(); } catch { /* gone */ } };
  process.on('SIGINT', async () => { await stopSim(); process.exit(0); });
  process.on('SIGTERM', async () => { await stopSim(); process.exit(0); });
  const simTimeout = Number(getArg(argv, 'timeout', 0));
  if (simTimeout > 0) setTimeout(stopSim, simTimeout);
  await closed;
  ctx.event('preview', { stage: 'cleanup', status: 'sim_stop', exitCode: 0 });
  process.exit(0);
}

const server = createStaticServer(distDir, {
  pathPrefix: hostPrefix,
  injectAppId: appId,
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const url = hostPrefix ? `http://127.0.0.1:${port}${hostPrefix}/` : `http://127.0.0.1:${port}/`;
ctx.event('preview', { stage: 'cleanup', status: 'server_start', url, path: distDir });
console.log(JSON.stringify({ runId, stage: 'preview', url }));
console.log(`preview: serving ${distDir}`);
console.log(`preview: ${url}  (Ctrl+C to stop)`);

// Default: HEADED Chrome window kích thước điện thoại + mobile emulation (yêu cầu user
// 2026-08-21 — cửa sổ desktop full "nhìn ghê"). `--desktop` giữ hành vi cũ (default browser).
let mobileBrowser = null;
if (!argv.includes('--no-open')) {
  if (argv.includes('--desktop')) {
    // macOS default browser; failure to open is not fatal — the URL is printed above.
    const opener = spawn('open', [url], { stdio: 'ignore', detached: true });
    opener.on('error', () => { /* non-macOS or no opener — URL already printed */ });
    opener.unref();
  } else {
    try {
      const { chromium } = await import('playwright-core');
      const vp = loadLabConfig().defaults?.defaultViewport ?? { width: 390, height: 844 };
      mobileBrowser = await chromium.launch({ channel: 'chrome', headless: false });
      const context = await mobileBrowser.newContext({
        viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      });
      const page = await context.newPage();
      console.log(`preview: cửa sổ Chrome mobile ${vp.width}x${vp.height} — đóng cửa sổ hoặc Ctrl+C để dừng (dùng --desktop nếu muốn mở browser mặc định)`);
      await page.goto(url).catch((err) => console.error(`preview: ${err.message}`));
      mobileBrowser.on('disconnected', () => stop(0));
    } catch (err) {
      // playwright/Chrome unavailable → fallback default browser, không chặn preview
      console.error(`preview: mobile window unavailable (${err.message}) — falling back to default browser`);
      const opener = spawn('open', [url], { stdio: 'ignore', detached: true });
      opener.on('error', () => { /* URL already printed */ });
      opener.unref();
    }
  }
}

const stop = (code) => {
  try { server.close(); } catch { /* already closed */ }
  if (mobileBrowser) mobileBrowser.close().catch(() => { /* gone */ });
  ctx.event('preview', { stage: 'cleanup', status: 'server_stop', exitCode: code });
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const timeoutMs = Number(getArg(argv, 'timeout', 0));
if (timeoutMs > 0) setTimeout(() => stop(0), timeoutMs);
// otherwise the listening server keeps the event loop alive until Ctrl+C
