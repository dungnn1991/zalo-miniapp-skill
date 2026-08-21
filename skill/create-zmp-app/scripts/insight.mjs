// insight.mjs — Phase 2.6 quality-insight helpers (Subagent C owned, NOT scripts/lib/).
// Tier-1 preflight scanners (plan 29 §2.1) + Tier-2 error-signature matcher (§2.2) +
// the evidence/preflight.json accumulator that verify.mjs folds into result gates/insights.
// Pure helpers: no process.exit, no direct evidence writes except through the passed ctx.
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR } from './lib/paths.mjs';

// ---------------------------------------------------------------------------------------
// evidence/preflight.json — {gates:[{id, status: pass|warn|fail, detail, insight?}]}
// Entries are idempotent by id (re-runs replace, never duplicate).
export function appendPreflight(ctx, entry) {
  const cur = ctx.readJson('evidence/preflight.json') ?? { gates: [] };
  const i = cur.gates.findIndex((g) => g.id === entry.id);
  if (i >= 0) cur.gates[i] = entry;
  else cur.gates.push(entry);
  ctx.writeJson('evidence/preflight.json', cur);
  return entry;
}

// ---------------------------------------------------------------------------------------
// src/ text corpus: [{rel, text}] for every source-ish file. Missing src/ → [].
const SRC_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.json']);
// BUILD OUTPUT không phải source: official templates (vite root ./src) build vào src/www —
// bundle chứa zmp-sdk có chuỗi graph.zalo.me hợp lệ của chính SDK → quét sẽ false-positive
// blocking (finding_30d7006aeaa7, repro thật từ Codex run 2026-08-21). node_modules tương tự.
const SRC_EXCLUDE_DIRS = new Set(['www', 'dist', 'node_modules', '.git']);
export function readSrcTexts(appDir) {
  const srcDir = path.join(appDir, 'src');
  if (!fs.existsSync(srcDir)) return [];
  const out = [];
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SRC_EXCLUDE_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && SRC_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push({ rel: path.relative(appDir, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Tier-1 scanners. Each returns a preflight entry {id, status, detail, insight?}.

// FAQ 24: deployed bundle limits — total ≤10MB, single file ≤3MB. Hard fail.
export const SIZE_TOTAL_LIMIT = 10 * 1024 * 1024;
export const SIZE_FILE_LIMIT = 3 * 1024 * 1024;
export const EXPECTED_SIZE_LIMIT = 'build output within platform size limits (total <= 10MB, each file <= 3MB)';
export function scanSizeLimit(outDirPath) {
  let total = 0;
  const oversized = [];
  const stack = [outDirPath];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        total += size;
        if (size > SIZE_FILE_LIMIT) oversized.push(`${path.relative(outDirPath, full)} (${(size / 1048576).toFixed(1)}MB)`);
      }
    }
  }
  const overTotal = total > SIZE_TOTAL_LIMIT;
  if (!overTotal && oversized.length === 0) {
    return { id: 'size_limit', status: 'pass', detail: `total ${(total / 1048576).toFixed(1)}MB, no file over 3MB` };
  }
  const problems = [];
  if (overTotal) problems.push(`total ${(total / 1048576).toFixed(1)}MB > 10MB`);
  if (oversized.length) problems.push(`files over 3MB: ${oversized.join(', ')}`);
  return {
    id: 'size_limit',
    status: 'fail',
    detail: problems.join('; '),
    insight: {
      diagnosis: 'Bundle vượt giới hạn nền tảng (tổng 10MB / file 3MB) — deploy chắc chắn fail.',
      fix: 'Nén/resize ảnh, chuyển asset lớn sang CDN, code-split; kiểm tra lại kích thước outDir trước khi deploy.',
      source: 'community-faq #24',
    },
  };
}

// FAQ 23: absolute asset paths work on localhost but 404 on the zapps CDN base.
export function scanAssetPaths(srcTexts) {
  const re = /(?:src|href)\s*=\s*["']\/(?!\/)[^"']*\.(?:png|jpe?g|gif|svg|webp|ico|woff2?)["']|\.\.\/public\//i;
  const hits = srcTexts.filter(({ text }) => re.test(text)).map(({ rel }) => rel);
  if (!hits.length) return { id: 'asset_path_scan', status: 'pass', detail: 'no absolute asset paths in src/' };
  return {
    id: 'asset_path_scan',
    status: 'warn',
    detail: `absolute asset path in: ${hits.join(', ')}`,
    insight: {
      diagnosis: 'Asset tham chiếu bằng đường dẫn tuyệt đối ("/xxx.png" hoặc ../public/) — chạy được trên localhost nhưng chết trên CDN (base zapps/<appId>/).',
      fix: 'Import asset qua module syntax (import img from "./img.png") hoặc đường dẫn tương đối để bundler rewrite.',
      source: 'community-faq #23',
    },
  };
}

// FAQ 22: server-side endpoints / secrets in client code — security hole, hard fail.
export const EXPECTED_SERVER_SIDE_API = 'client code never calls server-side Zalo endpoints or embeds secrets (server_side_api_scan)';
export function scanServerSideApi(srcTexts) {
  const endpointRe = /graph\.zalo\.me|openapi\.mini\.zalo\.me|business\.openapi/i;
  const secretRe = /(app_secret|private_key|secret_key)\s*[:=]/i;
  const hits = [];
  for (const { rel, text } of srcTexts) {
    if (endpointRe.test(text)) hits.push(`${rel} (server-side endpoint)`);
    else if (secretRe.test(text)) hits.push(`${rel} (secret-shaped literal)`);
  }
  if (!hits.length) return { id: 'server_side_api_scan', status: 'pass', detail: 'no server-side API/secret in src/' };
  return {
    id: 'server_side_api_scan',
    status: 'fail',
    detail: `server-side API or secret in client code: ${hits.join(', ')}`,
    insight: {
      diagnosis: 'Client gọi endpoint server-side (graph.zalo.me/OpenAPI) hoặc nhúng secret — lỗ hổng bảo mật, secret lộ trong bundle.',
      fix: 'Chuyển logic này sang server của bạn; Mini App chỉ gọi server đó qua HTTPS + CORS.',
      source: 'community-faq #22',
    },
  };
}

// FAQ 20: permission-gated zmp-sdk APIs fail only for NORMAL users until registered.
export function scanPermissionApis(srcTexts) {
  const re = /getPhoneNumber|getLocation|openMediaPicker|requestCameraPermission|keepScreen(?:On)?|nativeStorage/;
  const hits = [];
  for (const { rel, text } of srcTexts) {
    const m = text.match(re);
    if (m) hits.push(`${rel} (${m[0]})`);
  }
  if (!hits.length) return { id: 'permission_registry_hint', status: 'pass', detail: 'no permission-gated zmp-sdk API in src/' };
  return {
    id: 'permission_registry_hint',
    status: 'warn',
    detail: `permission-gated APIs used: ${hits.join(', ')}`,
    insight: {
      diagnosis: 'App dùng API cần khai báo quyền (getPhoneNumber/getLocation/...). Dev/admin KHÔNG thấy lỗi khi test — chỉ user thường bị chặn.',
      fix: 'Đăng ký từng quyền ở mục Quản lý quyền trên Zalo Developers trước khi gửi xét duyệt.',
      source: 'community-faq #20',
    },
  };
}

// FAQ 01: price + cart flow without Checkout SDK — review-policy warning.
export function scanCheckoutPolicy(srcTexts) {
  const all = srcTexts.map((s) => s.text).join('\n');
  const hasPrice = /\d[\d.,]*\s*(?:₫|đ\b|vnd)|price\s*[:=]/i.test(all);
  const hasCart = /addToCart|add-to-cart|giỏ hàng|\bcart\b/i.test(all);
  const hasCheckoutSdk = /checkout-?sdk|zmp-checkout/i.test(all);
  if (!(hasPrice && hasCart) || hasCheckoutSdk) {
    return { id: 'checkout_sdk_policy_hint', status: 'pass', detail: hasCheckoutSdk ? 'checkout sdk present' : 'no price+cart flow detected' };
  }
  return {
    id: 'checkout_sdk_policy_hint',
    status: 'warn',
    detail: 'price + cart/order flow present without Checkout SDK',
    insight: {
      diagnosis: 'App có giá tiền + giỏ hàng/đặt hàng nhưng không tích hợp Checkout SDK — chính sách xét duyệt có thể yêu cầu.',
      fix: 'Cân nhắc tích hợp Checkout SDK của Zalo Mini App cho flow thanh toán trước khi gửi xét duyệt.',
      source: 'community-faq #01',
    },
  };
}

// FAQ 16: ZMP_TOKEN in the process environment silently overrides app/.env (CI/CD trap).
// Existence-only check — the value is never read beyond `in`.
export function scanZmpTokenEnvOverride(env = process.env) {
  if (!('ZMP_TOKEN' in env)) return { id: 'zmp_token_env_override_hint', status: 'pass', detail: 'no ZMP_TOKEN in process env' };
  return {
    id: 'zmp_token_env_override_hint',
    status: 'warn',
    detail: 'process env carries a ZMP_TOKEN key (existence only — value never read)',
    insight: {
      diagnosis: 'Biến môi trường ZMP_TOKEN đang tồn tại và sẽ đè token trong app/.env — bẫy CI/CD khó nhận biết (deploy bằng token khác với token vừa login).',
      fix: 'Unset ZMP_TOKEN khỏi environment (hoặc xác nhận đây là chủ đích) trước khi deploy.',
      source: 'community-faq #16',
    },
  };
}

// ---------------------------------------------------------------------------------------
// FAQ 04: CORS preflight probe. Extract http(s) URL literals that sit on a fetch/axios line,
// dedupe by origin, skip Zalo-owned hosts, then really probe OPTIONS with the h5.zdn.vn
// Origin. 127.0.0.1/localhost origins are probed (case mock servers); other http/bare-IP
// origins warn without probing (secure-context rule).
const ZALO_OWNED_RE = /(^|\.)(zalo\.me|zdn\.vn|zaloplatforms\.com)$/i;
export function extractFetchOrigins(srcTexts) {
  const origins = new Set();
  for (const { text } of srcTexts) {
    for (const line of text.split('\n')) {
      if (!/fetch\s*\(|axios/i.test(line)) continue;
      for (const m of line.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/gi)) {
        try {
          const u = new URL(m[0]);
          if (!ZALO_OWNED_RE.test(u.hostname)) origins.add(u.origin);
        } catch { /* not a URL */ }
      }
    }
  }
  return [...origins];
}

export async function probeCorsOrigin(origin, { timeoutMs = 5000 } = {}) {
  const u = new URL(origin);
  const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (!isLocal) {
    if (u.protocol === 'http:') return { origin, status: 'warn', problem: 'insecure_http' };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return { origin, status: 'warn', problem: 'bare_ip' };
  }
  try {
    const res = await fetch(`${origin}/`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://h5.zdn.vn', 'Access-Control-Request-Method': 'GET' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const acao = res.headers.get('access-control-allow-origin');
    if (!acao || (acao !== '*' && !acao.includes('h5.zdn.vn'))) {
      return { origin, status: 'warn', problem: 'missing_acao', acao: acao ?? null };
    }
    return { origin, status: 'ok', acao };
  } catch (err) {
    return { origin, status: 'warn', problem: 'unreachable', detail: String(err?.cause?.code ?? err.message).slice(0, 120) };
  }
}

export async function corsPreflightGate(srcTexts, { timeoutMs = 5000 } = {}) {
  const origins = extractFetchOrigins(srcTexts);
  if (!origins.length) return { id: 'cors_preflight_probe', status: 'pass', detail: 'no external fetch/axios origins in src/' };
  const results = await Promise.all(origins.map((o) => probeCorsOrigin(o, { timeoutMs })));
  const problems = results.filter((r) => r.status === 'warn');
  if (!problems.length) {
    return { id: 'cors_preflight_probe', status: 'pass', detail: `${origins.length} origin(s) allow https://h5.zdn.vn` };
  }
  const detail = problems.map((p) => `${p.origin}: ${p.problem}${p.acao !== undefined ? ` (ACAO=${p.acao})` : ''}`).join('; ');
  const hasUnreachable = problems.some((p) => p.problem === 'unreachable');
  const hasInsecure = problems.some((p) => p.problem === 'insecure_http' || p.problem === 'bare_ip');
  const diagnosis = [
    problems.some((p) => p.problem === 'missing_acao')
      ? 'Server API không trả Access-Control-Allow-Origin cho https://h5.zdn.vn — fetch sẽ bị browser chặn khi app chạy trên Zalo.'
      : null,
    hasInsecure ? 'Origin dùng http:// hoặc IP trần — Mini App chạy trong secure context, yêu cầu HTTPS + domain hợp lệ.' : null,
    hasUnreachable ? 'Một số origin unreachable khi probe — có thể server chưa chạy hoặc chặn OPTIONS (semantics khác thiếu CORS).' : null,
  ].filter(Boolean).join(' ');
  return {
    id: 'cors_preflight_probe',
    status: 'warn',
    detail,
    insight: {
      diagnosis,
      fix: 'Fix ở SERVER (không phải Mini App): trả Access-Control-Allow-Origin: https://h5.zdn.vn (hoặc *), dùng HTTPS với domain hợp lệ, cho phép method OPTIONS.',
      source: 'community-faq #04',
    },
  };
}

// ---------------------------------------------------------------------------------------
// Tier-2: error-signature matcher. references/error-signatures.json is curated by Subagent A
// ({signatures:[{id,pattern,flags,stage,diagnosis,fix,source}]}); absence → no matches.
const SIGNATURES_PATH = path.join(SKILL_DIR, 'references', 'error-signatures.json');
let signaturesCache;
export function loadSignatures() {
  if (signaturesCache !== undefined) return signaturesCache;
  try {
    const data = JSON.parse(fs.readFileSync(SIGNATURES_PATH, 'utf8'));
    signaturesCache = Array.isArray(data?.signatures) ? data.signatures : [];
  } catch {
    signaturesCache = []; // not curated yet, or unparsable — matcher stays silent
  }
  return signaturesCache;
}

export function matchSignatures(text, stage = null) {
  const out = [];
  if (!text) return out;
  for (const sig of loadSignatures()) {
    if (!sig?.pattern || !sig?.diagnosis || !sig?.fix) continue;
    if (stage && sig.stage && sig.stage !== stage) continue;
    let re;
    try { re = new RegExp(sig.pattern, sig.flags ?? 'i'); } catch { continue; }
    if (re.test(text)) {
      out.push({ id: sig.id ?? sig.pattern, diagnosis: sig.diagnosis, fix: sig.fix, source: sig.source ?? null });
    }
  }
  return out;
}
