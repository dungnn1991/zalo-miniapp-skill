// intercept.mjs — simulator serve-interception shared by runner (lead imports) and
// preview.mjs (Subagent C owns scripts/sim/). Plan 28 / config.json sdkHostContract:
// isMp detection needs the REAL hostname h5.zdn.vn + /zapps path, so the app is served via
// playwright route interception at https://h5.zdn.vn/zapps/<appId>/ — no local server, no DNS.
//
// Export contract (LOCKED with lead): `async setupSimContext(context, manifest)` — routes
// every https://h5.zdn.vn/** request of the context, injects the shim + __SIM_CONFIG__ into
// index.html at serve time, appends bridge-log POSTs to manifest.logEvidencePathAbs.
// manifest = { appId, outDirAbs, shimPathAbs, simConfig: {appId, decision, persona, apis},
//              logEvidencePathAbs }  (written by render.mjs as runs/<id>/sim-serve-manifest.json)
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from '../lib/paths.mjs';
import { redactText } from '../lib/redact.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export const simUrl = (appId) => `https://h5.zdn.vn/zapps/${appId}/`;

// Inject __SIM_CONFIG__ + the shim source right before the first module script (or right
// after <head>) — the shim must run before the app bundle (sdkHostContract.injectionPoint).
function injectShim(html, manifest, shimSource) {
  const tag = `<script>window.__SIM_CONFIG__=${JSON.stringify(manifest.simConfig)};</script>\n<script>${shimSource}</script>`;
  const moduleScript = /<script[^>]*type=["']?module/i;
  if (moduleScript.test(html)) return html.replace(moduleScript, (m) => `${tag}${m}`);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  return tag + html;
}

export async function setupSimContext(context, manifest) {
  const outDir = manifest.outDirAbs;
  const indexHtml = path.join(outDir, 'index.html');
  const shimSource = fs.readFileSync(manifest.shimPathAbs, 'utf8');
  const prefix = `/zapps/${manifest.appId}`;
  fs.mkdirSync(path.dirname(manifest.logEvidencePathAbs), { recursive: true });

  const serveIndex = (route) => route.fulfill({
    status: 200,
    contentType: MIME['.html'],
    body: injectShim(fs.readFileSync(indexHtml, 'utf8'), manifest, shimSource),
  });

  await context.route('https://h5.zdn.vn/**', async (route) => {
    try {
      const req = route.request();
      const u = new URL(req.url());
      // bridge log sink — shape {at, action, api, decision, error_code, unmocked}; no payloads
      if (u.pathname === '/__sim__/log') {
        if (req.method() === 'POST') {
          try {
            fs.appendFileSync(manifest.logEvidencePathAbs, redactText(req.postData() || '{}') + '\n');
          } catch { /* log sink must never break the app */ }
        }
        return route.fulfill({ status: 204, body: '' });
      }
      let rel = decodeURIComponent(u.pathname);
      if (rel === prefix || rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length) || '/';
      const file = path.resolve(outDir, '.' + path.posix.normalize('/' + rel));
      if (file !== outDir && !file.startsWith(outDir + path.sep)) {
        return route.fulfill({ status: 403, body: 'forbidden' });
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory() || file === indexHtml) {
        return serveIndex(route); // index + SPA fallback
      }
      return route.fulfill({
        status: 200,
        contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        body: fs.readFileSync(file),
      });
    } catch (err) {
      return route.fulfill({ status: 500, body: `sim serve error: ${err.message}` });
    }
  });

  // Safety net: no simulated run ever reaches the real Zalo backends. The shim's fetch patch
  // answers these in-page first; this catches anything else (script tags, unpatched clients).
  // Document/iframe destinations (vd OA widget của zaui templates) nhận HTML placeholder
  // thay vì JSON — JSON thô render giữa trang nhìn như app vỡ (repro Codex 2026-08-21).
  await context.route(/https:\/\/((h5|graph|payment-mini)\.zalo\.me|oauth\.zaloapp\.com)\//, (route) => {
    const rt = route.request().resourceType();
    if (rt === 'document' || rt === 'iframe' || rt === 'subframe') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;color:#9aa0a6;font:12px sans-serif">SIMULATOR: widget ngoài bị chặn</body></html>',
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ err: -1, error: -1, message: 'blocked by simulator' }),
    });
  });
}

// Manifest builder shared by render.mjs (writes it for the runner) and preview.mjs (in-memory).
// runCtx = openRun(...) context of the run; ws = resolveWorkspace(...).
export function buildSimManifest(runCtx, ws, { decision = 'accept' } = {}) {
  const outDir = runCtx.readJson('evidence/build-info.json')?.outDir ?? 'dist';
  const input = runCtx.readJson('input.json');
  const appId = input?.miniAppId ?? null;
  let registry = {};
  try {
    registry = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'references', 'sim-mock-data.json'), 'utf8'));
  } catch { /* Subagent A still curating — shim then answers everything as unmocked */ }
  return {
    appId,
    outDirAbs: path.join(ws.appDir, outDir),
    shimPathAbs: path.join(SKILL_DIR, 'scripts', 'sim', 'shim.js'),
    simConfig: {
      appId,
      decision,
      persona: registry.persona ?? null,
      apis: registry.apis ?? {},
    },
    logEvidencePathAbs: path.join(runCtx.runDir, 'evidence', 'bridge-log.jsonl'),
  };
}
