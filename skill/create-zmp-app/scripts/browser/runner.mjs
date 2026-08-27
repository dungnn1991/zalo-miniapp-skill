#!/usr/bin/env node
// Locked browser render oracle (lead-owned). Subagents build AROUND this, not inside it.
//
// Usage:
//   node scripts/browser/runner.mjs --url <http-url> --out <evidence-dir> [--config <lab.config.json>]
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
import { redactText } from '../lib/redact.mjs';

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

// Oracle profile: "full" (default), "official-template", "simulator" (Phase 3) or
// "simulator-official". Two orthogonal axes, deliberately not one flag (mandate 42 §3.3):
//   sim SERVING   — host interception + shim + runtime marker + bridge log (isSim)
//   lab MARKERS   — the 8 data-testid gates, cta and the interaction check (isFull)
//   sim DEMO-FLOW — the lab template's account-tab permission demo (demoFlow)
// An official template gets sim serving without lab markers and without the demo flow.
const profileName = arg('profile', 'full');
const profile = (cfg.oracleProfiles || {})[profileName];
if (!profile) {
  console.error(`runner_error: unknown profile "${profileName}" (see config.json oracleProfiles)`);
  process.exit(3);
}
const isSim = profileName === 'simulator' || profileName === 'simulator-official';
const isFull = profileName === 'full' || profileName === 'simulator';
const runsDemoFlow = isSim && profile.demoFlow !== false;
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

// --- uncaught-payload capture (report 41 §6.1) --------------------------------------------
// Playwright's `pageerror` hands us a PlaywrightError rebuilt from the page, and a thrown
// non-Error is flattened before it ever reaches node: a `throw {code:-2000, detail:{…}}`
// arrives as name="" message="Object" stack="" — so name/message/stack and JSON.stringify(err)
// all lose the payload (measured, zmp-qualify probe 2026-08-23; this is why zaui-market's
// evidence read literally "Object"). The only place the original value still exists is the
// page, so we serialize it THERE, in a window 'error'/'unhandledrejection' listener installed
// before the app bundle, and ship it out over an exposed function.
//
// These lines are EVIDENCE ONLY: kind='error-detail' never touches fatalConsole. `pageerror`
// stays the sole fatal counter so the gate keeps its exact previous semantics.
const ERROR_DETAIL_SINK = '__zmpDxErrorSink';
const ERROR_DETAIL_MAX_CHARS = 4000;   // per record, after serialization
const ERROR_DETAIL_MAX_RECORDS = 25;   // per viewport — a render loop must not fill the disk

// Runs IN THE PAGE. Depth/width/length caps keep a cyclic or huge payload bounded; the node
// side redacts and caps again. Errors keep name/message/stack, everything else keeps its shape.
function installErrorDetailCapture(sinkName, maxChars) {
  const MAX_DEPTH = 4;
  const MAX_KEYS = 30;
  const MAX_ARRAY = 20;
  const MAX_STRING = 500;
  const clip = (s) => (s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '…[clipped]' : s);
  const ser = (v, depth, seen) => {
    if (v === null || v === undefined) return v === null ? null : '[undefined]';
    const t = typeof v;
    if (t === 'string') return clip(v);
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol' || t === 'function') return '[' + t + ' ' + clip(String(v.name || '')) + ']';
    if (v instanceof Error) {
      return { __type: 'Error', name: v.name, message: clip(String(v.message)), stack: clip(String(v.stack || '')) };
    }
    if (seen.has(v)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[depth-limit]';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out = v.slice(0, MAX_ARRAY).map((x) => ser(x, depth + 1, seen));
        if (v.length > MAX_ARRAY) out.push('…[' + (v.length - MAX_ARRAY) + ' more]');
        return out;
      }
      if (typeof Node !== 'undefined' && v instanceof Node) return '[DOM ' + (v.nodeName || 'Node') + ']';
      const out = {};
      const keys = Object.keys(v).slice(0, MAX_KEYS);
      for (const k of keys) {
        try { out[k] = ser(v[k], depth + 1, seen); } catch (e) { out[k] = '[getter threw]'; }
      }
      const total = Object.keys(v).length;
      if (total > MAX_KEYS) out['…'] = '[' + (total - MAX_KEYS) + ' more key(s)]';
      if (!keys.length && v.constructor && v.constructor.name && v.constructor.name !== 'Object') {
        out.__type = v.constructor.name;
      }
      return out;
    } finally {
      seen.delete(v);
    }
  };
  const send = (source, value) => {
    try {
      let text = JSON.stringify(ser(value, 0, new Set()));
      if (typeof text !== 'string') text = String(text);
      if (text.length > maxChars) text = text.slice(0, maxChars) + '…[clipped]';
      window[sinkName](source, text, typeof value, value instanceof Error);
    } catch (e) { /* evidence capture must never break the app */ }
  };
  window.addEventListener('error', (ev) => {
    // Resource load failures fire a plain Event with no payload — browser noise, not an
    // uncaught value; page.on('console') already records them.
    if (typeof ErrorEvent === 'undefined' || !(ev instanceof ErrorEvent)) return;
    send('window.onerror', 'error' in ev && ev.error !== undefined && ev.error !== null
      ? ev.error
      : { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno });
  });
  window.addEventListener('unhandledrejection', (ev) => send('unhandledrejection', ev.reason));
}

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

    // Uncaught-payload capture: the sink must exist before the init script runs, and both
    // before any page of this context loads. Failure here is non-fatal — the run still
    // produces the same gates, only without the extra diagnostic lines.
    let detailRecords = 0;
    try {
      await context.exposeFunction(ERROR_DETAIL_SINK, (source, text, valueType, isError) => {
        if (detailRecords >= ERROR_DETAIL_MAX_RECORDS) return;
        detailRecords++;
        logConsole({
          viewport: vpName,
          kind: 'error-detail',
          source,
          valueType,
          isError: !!isError,
          text: redactText(String(text)).slice(0, ERROR_DETAIL_MAX_CHARS),
          at: new Date().toISOString(),
        });
      });
      await context.addInitScript(
        { content: `(${installErrorDetailCapture.toString()})(${JSON.stringify(ERROR_DETAIL_SINK)}, ${ERROR_DETAIL_MAX_CHARS});` },
      );
    } catch (err) {
      logConsole({ viewport: vpName, kind: 'runner-note', text: `error-detail capture unavailable: ${String(err.message).slice(0, 200)}`, at: new Date().toISOString() });
    }

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

      // DX runtime marker (mandate 42 §3.2). The simulator serves from the REAL hostname and
      // path so zmp-sdk detects the right environment — which means nothing about the URL can
      // distinguish simulator from production. The marker is the only signal, so both
      // directions are gated: present and well-formed under sim serving, and absent everywhere
      // else. A leaked marker outside the simulator would let a template hand out mock data in
      // a real host.
      const dxRuntime = await page.evaluate(() => {
        const m = window.__ZMP_DX_RUNTIME__;
        if (!m || typeof m !== 'object') return null;
        return { schemaVersion: m.schemaVersion ?? null, mode: m.mode ?? null, hasMockData: !!m.mockData };
      });
      vpSummary.dxRuntime = dxRuntime;
      if (isSim) {
        const ok = dxRuntime && dxRuntime.schemaVersion === 1 && dxRuntime.mode === 'simulator';
        gate('sim_runtime_marker', ok ? 'pass' : 'fail',
          ok ? 'window.__ZMP_DX_RUNTIME__ schemaVersion=1 mode=simulator' : `marker missing/invalid: ${JSON.stringify(dxRuntime)}`,
          vpName);
      } else {
        gate('no_sim_runtime_marker', dxRuntime === null ? 'pass' : 'fail',
          dxRuntime === null ? 'no window.__ZMP_DX_RUNTIME__ outside the simulator' : `marker leaked into a non-simulator run: ${JSON.stringify(dxRuntime)}`,
          vpName);
      }

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
      // Lab profile only: the markers this drives are the lab template's account tab.
      if (runsDemoFlow && vp.isDefault && cfg.simulatorDemo) {
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
    // The sink is an async round-trip; give in-flight records a moment to land before the
    // context (and with it the binding) goes away.
    await page.waitForTimeout(150).catch(() => {});
    await context.close();
  }
} finally {
  await browser.close();
}

if (isSim) {
  const logPath = simManifest.logEvidencePathAbs;
  const ok = logPath && fs.existsSync(logPath) && fs.statSync(logPath).size > 0;
  if (runsDemoFlow) {
    // Lab demo flow always crosses the bridge (it clicks every demo API), so an empty log
    // means the interception never engaged.
    gate('sim_bridge_log_written', ok ? 'pass' : 'fail', ok ? logPath : 'bridge-log missing/empty');
  } else {
    // An official template may legitimately make no native call at all on first render
    // (zaui-fashion and zaui-doctor do not). Absence of a log is then evidence of nothing —
    // `sim_runtime_marker` is what proves the shim was injected and running.
    gate('sim_bridge_log_written', ok ? 'pass' : 'skipped',
      ok ? logPath : `profile ${profileName}: app made no native call — nothing to log (marker gate proves the shim ran)`);
  }
}

fs.writeFileSync(path.join(outDir, 'dom.json'), JSON.stringify(domSummary, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'gates.json'), JSON.stringify({ gates }, null, 2) + '\n');

const failed = gates.filter((g) => g.status === 'fail');
console.log(JSON.stringify({ pass: failed.length === 0, total: gates.length, failed: failed.length }));
process.exit(failed.length === 0 ? 0 : 1);
