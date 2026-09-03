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
import crypto from 'node:crypto';
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

// Stable, harness-owned merchant catalog. The client deliberately sends only product IDs and
// quantities; this table is the source of truth for amount/item/MAC in simulator mode. Lab
// clothing prices match their VND catalog. Neutral demo prices are converted from the source
// catalog's compact demo numbers to integer VND (x10,000) so Checkout never receives a
// fractional amount. This catalog lives in the simulator only and is never copied to dist.
const CHECKOUT_CATALOG = Object.freeze({
  'ceramic-mug': { name: 'Ceramic mug', unitPrice: 85000 },
  'desk-lamp': { name: 'Compact desk lamp', unitPrice: 240000 },
  'potted-plant': { name: 'Potted mini plant', unitPrice: 180000 },
  'dot-grid-notebook': { name: 'Dot-grid notebook', unitPrice: 60000 },
  'sticky-notes': { name: 'Sticky notes set', unitPrice: 35000 },
  'daypack-backpack': { name: 'Daypack backpack', unitPrice: 390000 },
  'picnic-basket': { name: 'Picnic basket', unitPrice: 220000 },
  'over-ear-headphones': { name: 'Over-ear headphones', unitPrice: 590000 },
  'wireless-mouse': { name: 'Wireless mouse', unitPrice: 155000 },
  'bluetooth-speaker': { name: 'Bluetooth speaker', unitPrice: 450000 },
  'ao-thun-cotton': { name: 'Áo thun cotton trơn', unitPrice: 129000 },
  'ao-so-mi': { name: 'Áo sơ mi tay dài', unitPrice: 259000 },
  'ao-khoac-gio': { name: 'Áo khoác gió nhẹ', unitPrice: 329000 },
  'quan-jean-slim': { name: 'Quần jean slim-fit', unitPrice: 349000 },
  'quan-short-kaki': { name: 'Quần short kaki', unitPrice: 199000 },
  'vay-hoa-mua-he': { name: 'Váy hoa mùa hè', unitPrice: 289000 },
  'dam-maxi-dao-pho': { name: 'Đầm maxi dạo phố', unitPrice: 399000 },
  'tui-tote-canvas': { name: 'Túi tote canvas', unitPrice: 149000 },
  'mu-luoi-trai': { name: 'Mũ lưỡi trai', unitPrice: 99000 },
  'kinh-ram': { name: 'Kính râm thời trang', unitPrice: 159000 },
  // Food delivery demo SKUs. These are simulator-only prices; a real merchant backend must
  // replace this catalog and remain authoritative for availability and amount.
  'com-tam-suon-bi': { name: 'Cơm tấm sườn bì chả', unitPrice: 59000 },
  'com-ga-xoi-mo': { name: 'Cơm gà xối mỡ', unitPrice: 62000 },
  'bun-bo-hue': { name: 'Bún bò Huế đặc biệt', unitPrice: 65000 },
  'pho-bo-tai': { name: 'Phở bò tái nạm', unitPrice: 69000 },
  'mi-quang-ga': { name: 'Mì Quảng gà', unitPrice: 55000 },
  'ga-ran-5-mieng': { name: 'Combo gà rán 5 miếng', unitPrice: 119000 },
  'pizza-hai-san': { name: 'Pizza hải sản phô mai', unitPrice: 169000 },
  'banh-trang-tron': { name: 'Bánh tráng trộn đặc biệt', unitPrice: 32000 },
  'tra-dao-cam-sa': { name: 'Trà đào cam sả', unitPrice: 35000 },
  'ca-phe-sua-da': { name: 'Cà phê sữa đá', unitPrice: 29000 },
});

const checkoutHash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function normalizeCheckoutItems(body) {
  const rawItems = Array.isArray(body?.items) ? body.items : [];
  const quantities = new Map();
  for (const raw of rawItems) {
    const productId = String(raw?.productId ?? raw?.id ?? '').trim();
    const quantity = Number(raw?.quantity ?? raw?.qty);
    if (!CHECKOUT_CATALOG[productId]) {
      const error = new Error(`unknown simulator product: ${productId || '<empty>'}`);
      error.status = 400;
      error.code = 'CHECKOUT_PRODUCT_UNKNOWN';
      throw error;
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      const error = new Error(`invalid quantity for ${productId}`);
      error.status = 400;
      error.code = 'CHECKOUT_QUANTITY_INVALID';
      throw error;
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }
  if (quantities.size === 0) {
    const error = new Error('checkout cart is empty');
    error.status = 400;
    error.code = 'CHECKOUT_CART_EMPTY';
    throw error;
  }
  return [...quantities.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([productId, quantity]) => {
      const product = CHECKOUT_CATALOG[productId];
      return {
        productId,
        name: product.name,
        quantity,
        unitPrice: product.unitPrice,
        lineTotal: product.unitPrice * quantity,
      };
    });
}

function createSimulatorMerchantOrder({ appId, body, idempotencyKey }) {
  const items = normalizeCheckoutItems(body);
  const amount = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const fingerprint = checkoutHash(JSON.stringify({ appId, items }));
  const stableKey = idempotencyKey || fingerprint;
  const merchantOrderId = `SIM-MERCHANT-${checkoutHash(`${appId}:${stableKey}`).slice(0, 16).toUpperCase()}`;
  const macMaterial = JSON.stringify({ appId, merchantOrderId, amount, items });
  const mac = `SIMULATOR_MAC_V1_${checkoutHash(macMaterial).slice(0, 32).toUpperCase()}`;
  return {
    fingerprint,
    response: {
      merchantOrderId,
      // Compatibility alias for clients that call their merchant-side ID simply `orderId`.
      // The later CheckoutSDK.createOrder response still supplies the distinct ZMP order ID.
      orderId: merchantOrderId,
      idempotencyKey: stableKey,
      amount,
      currency: 'VND',
      items,
      createOrderInput: {
        amount,
        item: items.map((item) => ({
          id: item.productId,
          name: item.name,
          price: item.unitPrice,
          quantity: item.quantity,
        })),
        desc: `Simulator order ${merchantOrderId.slice(-8)}`,
        mac,
        extradata: { merchantOrderId },
      },
      simulator: true,
    },
  };
}

// The stable contract a template/adapter is allowed to read (mandate 42 §3.2). Deliberately
// separate from __SIM_CONFIG__, which stays the shim's private config and may change shape.
//
// It must be a MARKER, not an inference: the simulator serves from the real hostname and path
// (h5.zdn.vn/zapps/<appId>) precisely so zmp-sdk detects the right environment, so URL,
// hostname and user-agent cannot tell simulator from production. Anything that reads this
// contract fails CLOSED — no marker, or a different schemaVersion, means "not the simulator".
//
// It only ever exists in memory at serve time. It is never written into source, .env, a dist
// artifact or a deploy.
export const DX_RUNTIME_SCHEMA_VERSION = 1;
export function buildRuntimeMarker(manifest) {
  return {
    schemaVersion: DX_RUNTIME_SCHEMA_VERSION,
    mode: 'simulator',
    appId: manifest.appId ?? null,
    mockData: {
      phoneNumber: manifest.simConfig?.persona?.phoneNumber ?? '0000000000',
    },
  };
}

// Inject the DX runtime marker + __SIM_CONFIG__ + the shim source right before the first
// module script (or right after <head>) — all three must run before the app bundle
// (sdkHostContract.injectionPoint).
function injectShim(html, manifest, shimSource) {
  const tag = `<script>window.__ZMP_DX_RUNTIME__=${JSON.stringify(buildRuntimeMarker(manifest))};`
    + `window.__SIM_CONFIG__=${JSON.stringify(manifest.simConfig)};</script>\n<script>${shimSource}</script>`;
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
  const merchantOrders = new Map();
  fs.mkdirSync(path.dirname(manifest.logEvidencePathAbs), { recursive: true });

  const appendEvidence = (entry) => {
    try {
      fs.appendFileSync(manifest.logEvidencePathAbs, redactText(JSON.stringify({
        at: new Date().toISOString(),
        ...entry,
      })) + '\n');
    } catch { /* evidence must never break the app */ }
  };

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
      if (u.pathname === '/api/merchant-orders') {
        if (req.method() !== 'POST') {
          return route.fulfill({
            status: 405,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'METHOD_NOT_ALLOWED', message: 'POST required' }),
          });
        }
        try {
          const body = JSON.parse(req.postData() || '{}');
          const headers = req.headers();
          const idempotencyKey = String(
            headers['idempotency-key']
              || headers['x-idempotency-key']
              || body.idempotencyKey
              || '',
          ).trim();
          const created = createSimulatorMerchantOrder({
            appId: manifest.appId,
            body,
            idempotencyKey,
          });
          const storeKey = idempotencyKey || created.response.idempotencyKey;
          const previous = merchantOrders.get(storeKey);
          if (previous && previous.fingerprint !== created.fingerprint) {
            appendEvidence({ action: 'merchant.create-order', api: 'checkout', decision: 'idempotency-conflict', error_code: 409 });
            return route.fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({
                code: 'CHECKOUT_IDEMPOTENCY_CONFLICT',
                message: 'Idempotency key was already used for a different cart',
              }),
            });
          }
          const result = previous?.response ?? created.response;
          if (!previous) merchantOrders.set(storeKey, created);
          appendEvidence({ action: 'merchant.create-order', api: 'checkout', decision: previous ? 'idempotent-replay' : 'mock-created', error_code: 0 });
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store', 'x-zmp-simulator': 'true' },
            body: JSON.stringify(result),
          });
        } catch (err) {
          const status = Number(err?.status) || 400;
          appendEvidence({ action: 'merchant.create-order', api: 'checkout', decision: 'rejected', error_code: status });
          return route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({
              code: err?.code || 'CHECKOUT_REQUEST_INVALID',
              message: err?.message || 'Invalid simulator checkout request',
            }),
          });
        }
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
export function buildSimManifest(runCtx, ws, { decision = 'accept', checkoutResult = 'success' } = {}) {
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
      checkout: {
        enabled: input?.capabilities?.includes('checkout') === true
          && (input?.checkoutMode ?? 'simulator') === 'simulator',
        result: ['success', 'pending', 'fail', 'cancel'].includes(checkoutResult)
          ? checkoutResult
          : 'success',
      },
    },
    logEvidencePathAbs: path.join(runCtx.runDir, 'evidence', 'bridge-log.jsonl'),
  };
}
