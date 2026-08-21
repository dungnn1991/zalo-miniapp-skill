#!/usr/bin/env node
// Locked browser render oracle (lead-owned). Subagents build AROUND this, not inside it.
//
// Usage:
//   node evaluation/browser/runner.mjs --url <http-url> --out <evidence-dir> [--config <lab.config.json>]
//
// Reads viewports, markers and the interaction check from lab.config.json (single source of truth).
// Writes into <evidence-dir>:
//   console.jsonl            one JSON line per console/pageerror event, tagged with viewport
//   dom.json                 per-viewport marker boxes, route, overflow measurements
//   gates.json               flat gate list ({id, status, detail, viewport}) for verify.mjs
//   <viewport-name>.png      screenshot per viewport with screenshot:true (initial state, pre-interaction)
//
// Exit codes: 0 all gates pass · 1 at least one gate failed · 3 runner/launch error.
// Uses playwright-core with the system Chrome channel — no browser download.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

let url = arg('url');
const outDir = arg('out');
// default: the package's own config.json (scripts/browser -> create-zmp-app/config.json)
const configPath = arg('config', path.resolve(__dirname, '..', '..', 'config.json'));

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { markers, viewports, interactionCheck } = cfg;

// Oracle profile: "full" (default), "official-template", or "simulator" (Phase 3).
// simulator: full gates + sim serve-interception (no external server) + demo API checks.
const profileName = arg('profile', 'full');
const profile = (cfg.oracleProfiles || {})[profileName];
if (!profile) {
  console.error(`runner_error: unknown profile "${profileName}" (see config.json oracleProfiles)`);
  process.exit(3);
}
const isSim = profileName === 'simulator';
const isFull = profileName === 'full' || isSim;
const mountSelector = isFull ? markers.appRoot : profile.mountSelector;

// Simulator mode: --sim-manifest replaces --url; pages are served via route interception
// at https://h5.zdn.vn/zapps/<appId>/ (sdkHostContract.servingRequirement — isMp needs the
// real hostname+path). Interception logic is shared with preview via scripts/sim/intercept.mjs.
let simManifest = null;
let setupSimContext = null;
if (isSim) {
  const manifestPath = arg('sim-manifest');
  if (!manifestPath) {
    console.error('runner_error: profile simulator requires --sim-manifest <abs path>');
    process.exit(3);
  }
  simManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  try {
    ({ setupSimContext } = await import(path.resolve(__dirname, '..', 'sim', 'intercept.mjs')));
  } catch (err) {
    console.error(`runner_error: cannot load scripts/sim/intercept.mjs: ${err.message}`);
    process.exit(3);
  }
  url = `https://h5.zdn.vn/zapps/${simManifest.appId}/`;
}
if (!url || !outDir) {
  console.error('usage: runner.mjs --url <url> --out <evidence-dir> [--config <path>] [--profile <p>] [--sim-manifest <path>]');
  process.exit(3);
}
// UA for simulator contexts: mobile Android + Zalo token (sdkHostContract.envDetection.platform)
const SIM_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Zalo android/24112050';
fs.mkdirSync(outDir, { recursive: true });

const consolePath = path.join(outDir, 'console.jsonl');
fs.writeFileSync(consolePath, '');
const logConsole = (rec) => fs.appendFileSync(consolePath, JSON.stringify(rec) + '\n');

const gates = [];
const gate = (id, status, detail, viewport) => gates.push({ id, status, detail, ...(viewport ? { viewport } : {}) });

const domSummary = { url, capturedAt: new Date().toISOString(), viewports: {} };

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
} catch (err) {
  console.error(`runner_error: cannot launch Chrome: ${err.message}`);
  process.exit(3);
}

try {
  for (const vp of viewports) {
    const vpName = vp.name;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      ...(isSim ? { userAgent: SIM_UA, ignoreHTTPSErrors: true } : {}),
    });
    if (isSim) await setupSimContext(context, simManifest);
    const page = await context.newPage();

    let fatalConsole = 0;
    page.on('console', (msg) => {
      const type = msg.type();
      const srcUrl = msg.location()?.url || '';
      logConsole({ viewport: vpName, kind: 'console', type, text: msg.text().slice(0, 2000), url: srcUrl, at: new Date().toISOString() });
      // favicon 404 is browser chrome noise, not an app failure; any other error stays fatal
      const faviconNoise = /favicon\.ico$/.test(srcUrl) && /Failed to load resource/.test(msg.text());
      if (type === 'error' && !faviconNoise) fatalConsole++;
    });
    page.on('pageerror', (err) => {
      logConsole({ viewport: vpName, kind: 'pageerror', text: String(err).slice(0, 2000), at: new Date().toISOString() });
      fatalConsole++;
    });

    let loaded = false;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
      await page.waitForSelector(mountSelector, { state: 'attached', timeout: 15000 });
      loaded = true;
      gate('react_mount', 'pass', `${mountSelector} attached`, vpName);
    } catch (err) {
      gate('react_mount', 'fail', `no ${mountSelector} within timeout: ${String(err.message).slice(0, 200)}`, vpName);
    }

    const vpSummary = { width: vp.width, height: vp.height, markers: {}, overflow: null, route: null };

    if (loaded) {
      // small settle for fonts/layout
      await page.waitForTimeout(400);

      for (const [key, selector] of Object.entries(isFull ? markers : {})) {
        const info = await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          if (!els.length) return { count: 0 };
          const r = els[0].getBoundingClientRect();
          return { count: els.length, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        }, selector);
        vpSummary.markers[key] = info;
        const ok = info.count > 0 && info.width > 0 && info.height > 0;
        gate(`marker_${key}`, ok ? 'pass' : 'fail',
          ok ? `${info.count}x, first ${info.width}x${info.height}` : `count=${info.count} size=${info.width ?? 0}x${info.height ?? 0}`,
          vpName);
      }

      // content gate (all profiles): a mounted-but-empty app must not pass (plan §8 — no blank marker pages)
      const content = await page.evaluate((sel) => {
        const mount = document.querySelector(sel);
        return {
          children: mount ? mount.childElementCount : 0,
          textLen: (document.body.innerText || '').trim().length,
        };
      }, mountSelector);
      vpSummary.content = content;
      gate('mount_not_empty', content.children > 0 && content.textLen > 0 ? 'pass' : 'fail',
        `children=${content.children} textLen=${content.textLen}`, vpName);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        route: location.pathname + location.hash,
      }));
      vpSummary.overflow = { scrollWidth: overflow.scrollWidth, innerWidth: overflow.innerWidth };
      vpSummary.route = overflow.route;
      const noOverflow = overflow.scrollWidth <= overflow.innerWidth + 1;
      gate('no_horizontal_overflow', noOverflow ? 'pass' : 'fail',
        `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`, vpName);

      // primary CTA must not be clipped horizontally (full profile only)
      if (isFull) {
        const cta = vpSummary.markers.addToCart;
        if (cta && cta.count > 0) {
          const ctaOk = cta.x >= 0 && cta.x + cta.width <= vp.width + 1;
          gate('cta_not_clipped', ctaOk ? 'pass' : 'fail', `cta x=${cta.x} width=${cta.width} viewport=${vp.width}`, vpName);
        } else {
          gate('cta_not_clipped', 'fail', 'no addToCart marker found', vpName);
        }
      } else {
        gate('cta_not_clipped', 'skipped', `profile ${profileName}: no lab markers`, vpName);
      }

      if (vp.screenshot) {
        await page.screenshot({ path: path.join(outDir, `${vpName}.png`), fullPage: false });
        gate('screenshot', 'pass', `${vpName}.png`, vpName);
      }

      // interaction check AFTER screenshot so screenshots show initial state (full profile only)
      if (!isFull && interactionCheck && interactionCheck.runOnViewports.includes(vpName)) {
        gate('interaction_add_to_cart', 'skipped', `profile ${profileName}: no lab markers`, vpName);
      }
      if (isFull && interactionCheck && interactionCheck.runOnViewports.includes(vpName)) {
        try {
          const badgeSel = markers[interactionCheck.expectCounterIncrement];
          const clickSel = markers[interactionCheck.click];
          const before = parseInt(await page.locator(badgeSel).first().innerText(), 10);
          await page.locator(clickSel).first().click({ timeout: 5000 });
          await page.waitForTimeout(300);
          const after = parseInt(await page.locator(badgeSel).first().innerText(), 10);
          const ok = Number.isInteger(before) && after === before + 1;
          gate('interaction_add_to_cart', ok ? 'pass' : 'fail', `badge ${before} -> ${after}`, vpName);
        } catch (err) {
          gate('interaction_add_to_cart', 'fail', String(err.message).slice(0, 200), vpName);
        }
      }

      // Simulator demo API checks — default viewport only (config.simulatorDemo contract).
      if (isSim && vp.isDefault && cfg.simulatorDemo) {
        const sd = cfg.simulatorDemo;
        const decision = simManifest.simConfig?.decision || 'accept';
        try {
          await page.locator(sd.navMarker).first().click({ timeout: 5000 });
          await page.waitForTimeout(300);
        } catch (err) {
          gate('sim_demo_nav', 'fail', `cannot open account tab: ${String(err.message).slice(0, 120)}`, vpName);
        }
        for (const api of sd.apis) {
          const btn = sd.buttonMarker.replace('<name>', api);
          const resultSel = sd.resultMarker.replace('<name>', api);
          const errorSel = sd.errorMarker.replace('<name>', api);
          // permission-less APIs (registry requiresPermission:false, e.g. getAccessToken on
          // SDK >=2.35) succeed regardless of decision: no sheet in manual, result in deny
          const needsPerm = simManifest.simConfig?.apis?.[api]?.requiresPermission !== false;
          try {
            await page.locator(btn).first().click({ timeout: 5000 });
            if (decision === 'manual' && needsPerm) {
              await page.waitForSelector(sd.sheetMarkers.sheet, { state: 'visible', timeout: 5000 });
              const badgeVisible = await page.locator(sd.sheetMarkers.badge).first().isVisible().catch(() => false);
              gate('sim_sheet_badge', badgeVisible ? 'pass' : 'fail', `badge on sheet for ${api}`, vpName);
              // visual evidence of the sheet (finding_aa3c32e71ef7)
              await page.screenshot({ path: path.join(outDir, `sim-sheet-${api}.png`) }).catch(() => {});
              await page.locator(sd.sheetMarkers.accept).first().click({ timeout: 5000 });
            }
            const expectSel = (decision === 'deny' && needsPerm) ? errorSel : resultSel;
            await page.waitForFunction(
              (sel) => (document.querySelector(sel)?.textContent || '').trim().length > 0,
              expectSel, { timeout: 8000 }
            );
            const text = await page.locator(expectSel).first().innerText();
            gate(`sim_demo_${api}`, 'pass', `${decision}: "${text.slice(0, 60)}"`, vpName);
          } catch (err) {
            gate(`sim_demo_${api}`, 'fail', `${decision}: ${String(err.message).slice(0, 140)}`, vpName);
          }
        }
        // sheet must never linger after flows complete
        const lingering = await page.locator(sd.sheetMarkers.sheet).first().isVisible().catch(() => false);
        if (lingering) gate('sim_sheet_closed', 'fail', 'permission sheet still visible after demo flows', vpName);
        // visual evidence: account tab end-state with results/errors (finding_aa3c32e71ef7)
        await page.screenshot({ path: path.join(outDir, `sim-demo-${decision}.png`) }).catch(() => {});
      }

      gate('no_fatal_console_error', fatalConsole === 0 ? 'pass' : 'fail', `${fatalConsole} error/pageerror event(s)`, vpName);
    } else {
      gate('no_fatal_console_error', fatalConsole === 0 ? 'pass' : 'fail', `${fatalConsole} error/pageerror event(s) (page did not mount)`, vpName);
    }

    domSummary.viewports[vpName] = vpSummary;
    await context.close();
  }
} finally {
  await browser.close();
}

if (isSim) {
  const logPath = simManifest.logEvidencePathAbs;
  const ok = logPath && fs.existsSync(logPath) && fs.statSync(logPath).size > 0;
  gate('sim_bridge_log_written', ok ? 'pass' : 'fail', ok ? logPath : 'bridge-log missing/empty');
}

fs.writeFileSync(path.join(outDir, 'dom.json'), JSON.stringify(domSummary, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'gates.json'), JSON.stringify({ gates }, null, 2) + '\n');

const failed = gates.filter((g) => g.status === 'fail');
console.log(JSON.stringify({ pass: failed.length === 0, total: gates.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
