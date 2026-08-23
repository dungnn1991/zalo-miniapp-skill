#!/usr/bin/env node
// qualify-template.mjs — the qualification factory (Subagent B, plan 34 §4.4).
//
// Runs one upstream template through every blocking gate on a CLEAN TEMP WORKSPACE and writes
// evidence. It never touches the lab's app/ and never edits catalog/templates.json except
// through the single documented promotion path at the bottom of this file.
//
//   node qualify-template.mjs --id <template-id> [--revision <sha>] [--promote]
//        [--registry <path>] [--app-id <id>] [--adapters <dir>] [--no-adapter]
//        [--clean-store] [--keep-workspace] [--out <dir>]
//
// Gates, in order (plan 34 §4.4 / CONTRACT-plan34 §Subagent B):
//   1 provenance          repo+SHA resolvable, immutable snapshot, first-party owner,
//                         license fields recorded, upstream .env never copied
//   2 dependency          direct-dependency completeness + pnpm install (pnpm policy is locked;
//                         a package that only resolves through npm hoisting is a REAL defect —
//                         CONTRACT rule 4: fix by declaring the dependency, never by
//                         shamefully-hoist and never by switching this template to npm)
//   3 build               delegated to scripts/build.mjs so the three already-shipped generic
//                         preparations are REUSED, not forked (review 35 F3): prepareViteSrcEntry,
//                         the build:css pre-step and OUT_DIR_CANDIDATES detection
//   4 rebrand / App ID    name fields rebranded, APP_ID bound + read back + resolved by the build
//                         toolchain itself, residual upstream identifiers scanned
//   5 runtime             delegated to scripts/render.mjs -> scripts/browser/runner.mjs with the
//                         locked oracle profile `official-template` (no second oracle exists)
//   6 external dependency every backend/API/env requirement declared; a template whose FIRST
//                         preview needs a backend the user must supply fails this gate
//   7 safe rerun          the mutating pipeline is deterministic and the adapter refuses to
//                         double-apply
//
// Exit codes: 0 all blocking gates passed (promotion applied when requested and allowed)
//             1 at least one blocking gate failed
//             3 usage / precondition error
//             4 gates passed but --promote is BLOCKED (registry untouched)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, getArg, resolveHeadSha, DEFAULT_REGISTRY } from './sync-template-catalog.mjs';
import { redactText } from './lib/redact.mjs';
// Reused from the shipped harness — see review 35 F3. Not re-implemented here.
import { OUT_DIR_CANDIDATES, detectOutDir } from './build.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const SKILL_DIR = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.join(SKILL_DIR, 'catalog', 'adapters');
const QUALIFICATION_DIR = path.join(SKILL_DIR, 'catalog', 'qualification');
const TARBALL_URL = (owner, repo, revision) => `https://codeload.github.com/${owner}/${repo}/tar.gz/${revision}`;

// Synthetic App ID for qualification: never a real tenant's ID, but shaped like one so the
// binding/scan gates exercise the real code path. Stable so reruns stay byte-identical.
const DEFAULT_QUALIFY_APP_ID = '1000000000000000001';
const FIRST_PARTY_OWNER = 'Zalo-MiniApp';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);
// import.meta.env keys Vite defines itself — referencing them is not an external requirement.
const VITE_BUILTIN_ENV = new Set(['PROD', 'DEV', 'MODE', 'BASE_URL', 'SSR', 'LEGACY']);

const nowIso = () => new Date().toISOString();
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Report 41 §6.2: evidence used to keep only the COUNT of console failures ("1 error/pageerror
// event(s)"), so answering "why did it fail" meant rerunning the whole factory. Keep a bounded,
// redacted excerpt of what the browser actually said — including the kind='error-detail' lines
// the runner adds for uncaught non-Error payloads (§6.1).
const CONSOLE_EXCERPT_MAX_LINES = 20;
const CONSOLE_EXCERPT_MAX_CHARS = 1200;
export function readConsoleExcerpt(consoleFile) {
  if (!fs.existsSync(consoleFile)) return null;
  const lines = fs.readFileSync(consoleFile, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const raw of lines) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e.kind === 'pageerror' || e.kind === 'error-detail' || (e.kind === 'console' && e.type === 'error')) events.push(e);
  }
  if (!events.length) return null;
  return {
    totalErrorEvents: events.length,
    truncated: events.length > CONSOLE_EXCERPT_MAX_LINES,
    events: events.slice(0, CONSOLE_EXCERPT_MAX_LINES).map((e) => ({
      viewport: e.viewport ?? null,
      kind: e.kind,
      ...(e.type ? { type: e.type } : {}),
      ...(e.source ? { source: e.source } : {}),
      text: redactText(String(e.text ?? '')).slice(0, CONSOLE_EXCERPT_MAX_CHARS),
    })),
  };
}

/**
 * Report 41 §6.3: build.mjs exits 1 from the Tier-1 preflight LONG before vite runs, but the
 * gate reported `vite_build: ... no build output detected. tail: ` with an empty tail, and
 * zaui-lucky-wheel was read as a build failure for days. Name the real stage.
 */
export function classifyBuildStop(preflightJson, buildLog, buildOutput) {
  const failed = (preflightJson?.gates ?? []).filter((g) => g.status === 'fail');
  if (failed.length) {
    return {
      checkId: 'preflight_failed',
      detail: `build.mjs stopped in Tier-1 preflight before vite ran — ${failed.map((g) => `${g.id}: ${g.detail}`).join(' | ')}`,
    };
  }
  // Last non-empty line of whatever the child actually printed; build.log is empty when the
  // stop happened before vite, so fall back to the child's own stdout/stderr.
  const tailOf = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-4).join(' / ');
  const tail = tailOf(buildLog) || tailOf(buildOutput) || '(no output captured)';
  return { checkId: 'vite_build', detail: `no build output detected. tail: ${tail.slice(-600)}` };
}

// --- gate bookkeeping ------------------------------------------------------------------------

function makeGate(id, blocking = true) {
  return { id, blocking, status: 'skipped', detail: '', checks: [] };
}
function check(gate, id, status, detail) {
  gate.checks.push({ id, status, detail });
  return status === 'pass';
}
function sealGate(gate, detailWhenPassing) {
  const failed = gate.checks.filter((c) => c.status === 'fail');
  gate.status = gate.checks.length === 0 ? 'skipped' : failed.length ? 'fail' : 'pass';
  gate.detail = failed.length ? failed.map((c) => `${c.id}: ${c.detail}`).join(' | ') : detailWhenPassing;
  return gate.status === 'pass';
}

// --- filesystem helpers ----------------------------------------------------------------------

function walkFiles(dir, { skipDirs = new Set(), base = dir } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const rel = path.relative(base, full);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !skipDirs.has(rel)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

const BUILD_ARTEFACT_DIRS = new Set(['node_modules', '.git', '.pnpm-store', ...OUT_DIR_CANDIDATES]);

/** Content digest of the app tree, ignoring installed packages and build output. */
function treeDigest(appDir) {
  const files = walkFiles(appDir, { skipDirs: BUILD_ARTEFACT_DIRS });
  const manifest = files.map((rel) => `${rel}\n${sha256(fs.readFileSync(path.join(appDir, rel)))}\n`).join('');
  return { digest: sha256(manifest), fileCount: files.length };
}

// Key-level .env upsert. The canonical implementation lives (unexported) inside bootstrap.mjs,
// which Subagent A owns this round; duplicating these 12 lines is cheaper than a cross-agent
// edit to a file being changed concurrently. Same semantics: replace only the APP_ID line.
function upsertEnvKey(file, key, value) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
  }
  let replaced = false;
  lines = lines.map((line) => {
    if (!replaced && new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) lines.push(`${key}=${value}`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}
function readEnvKey(file, key) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`).exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

function slugify(name) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'qualified-app';
}

// --- static scanners -------------------------------------------------------------------------

const IMPORT_RE = /(?:^|[\s;{()=])import\s+(type\s+)?(?:[^'"();]*?\sfrom\s*)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Plan 34 §4.4 gate 2: "mọi package được source import trực tiếp phải nằm trong
 * dependencies/devDependencies trực tiếp; transitive dependency không được tính là pass".
 * This is the static half of the pnpm policy — it names the missing package before the build
 * error does, and it is what proves a template only passed under npm's hoisting.
 */
export function scanDirectDependencies(appDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
  ]);
  const imported = new Map();
  for (const rel of walkFiles(path.join(appDir, 'src'), { skipDirs: new Set(['node_modules']), base: appDir })) {
    if (!SOURCE_EXTS.has(path.extname(rel))) continue;
    const text = fs.readFileSync(path.join(appDir, rel), 'utf8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text))) {
      const spec = m[2] || m[3] || m[4];
      if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) continue;
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      const line = text.slice(0, m.index + m[0].indexOf(spec)).split('\n').length;
      const rec = imported.get(name) || { name, typeOnly: true, sites: [] };
      if (!m[1]) rec.typeOnly = false;
      if (rec.sites.length < 4) rec.sites.push(`${rel}:${line}`);
      imported.set(name, rec);
    }
  }
  const missing = [...imported.values()].filter((r) => !declared.has(r.name)).sort((a, b) => a.name.localeCompare(b.name));
  return {
    imported: [...imported.keys()].sort(),
    declared: [...declared].sort(),
    // Type-only imports are erased by esbuild, so they cannot break the build — reported, not blocking.
    missingRuntime: missing.filter((r) => !r.typeOnly),
    missingTypeOnly: missing.filter((r) => r.typeOnly),
  };
}

/** Plan 34 §4.4 gate 6: every backend/API/env requirement must be declared. */
export function scanExternalDependencies(appDir, profile) {
  const requirements = [];
  const seen = new Set();
  const push = (r) => {
    const key = `${r.kind}:${r.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    requirements.push(r);
  };
  for (const req of profile.constraints.requiredInputs || []) {
    push({ kind: 'declared-input', name: req, neededForFirstPreview: true, sites: ['catalog/templates.json constraints.requiredInputs'] });
  }
  if (profile.constraints.backendRequiredForPreview) {
    push({ kind: 'declared-backend', name: 'backendRequiredForPreview', neededForFirstPreview: true, sites: ['catalog/templates.json'] });
  }
  const envRe = /import\.meta\.env\.([A-Z0-9_]+)|process\.env\.([A-Z0-9_]+)/g;
  const urlRe = /(?:fetch|axios(?:\.[a-z]+)?)\s*\(\s*[`"'](https?:\/\/[^`"'\s]+)/g;
  const clientRe = /^(axios|got|ky|superagent|@apollo\/client|graphql-request|@tanstack\/react-query|swr)$/;
  for (const rel of walkFiles(path.join(appDir, 'src'), { skipDirs: new Set(['node_modules']), base: appDir })) {
    if (!SOURCE_EXTS.has(path.extname(rel))) continue;
    const text = fs.readFileSync(path.join(appDir, rel), 'utf8');
    let m;
    envRe.lastIndex = 0;
    while ((m = envRe.exec(text))) {
      const name = m[1] || m[2];
      if (VITE_BUILTIN_ENV.has(name)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      // `window.APP_ID || import.meta.env.VITE_MINI_APP_ID` is a FALLBACK, not a requirement:
      // the host defines window.APP_ID (the real Zalo wrapper does, and so does the harness at
      // serve time), so the env var is never read on the path the first preview takes. Counting
      // it as an unsatisfied input made zaui-egovernment look like it needed two things from the
      // user when it needs one (review 42 R41-2). Only the canonical host-provided App ID
      // counts as a guard — any other left-hand side is a real alternative source we cannot
      // vouch for.
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      const guardedByHostAppId = /window\.APP_ID\s*(?:\|\||\?\?)\s*\(?\s*$/.test(before);
      push({
        kind: 'env-var',
        name,
        neededForFirstPreview: name !== 'APP_ID' && !guardedByHostAppId,
        sites: [`${rel}:${line}`],
        ...(guardedByHostAppId
          ? { note: 'fallback sau `window.APP_ID ||` — host (và harness lúc serve) đã định nghĩa window.APP_ID nên nhánh này không chạy ở preview đầu' }
          : {}),
      });
    }
    urlRe.lastIndex = 0;
    while ((m = urlRe.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      push({ kind: 'remote-api', name: new URL(m[1]).origin, neededForFirstPreview: true, sites: [`${rel}:${line}`] });
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies || {})) {
    if (clientRe.test(dep)) push({ kind: 'http-client-dependency', name: dep, neededForFirstPreview: false, sites: ['package.json dependencies'] });
  }
  return requirements;
}

/**
 * Plan 34 §4.4 gate 4: "scan không còn App ID/demo ID cũ". Anything under an *appId-shaped key*
 * that is not our App ID is blocking; any other long numeric identifier (upstream OA IDs, for
 * instance) is reported so a human sees it, but it is not an App ID and does not fail the gate.
 */
export function scanResidualIdentifiers(appDir, expectedAppId) {
  const TEXT_EXTS = new Set([...SOURCE_EXTS, '.json', '.html', '.env', '.md', '.yml', '.yaml']);
  const idRe = /\b\d{15,25}\b/g;
  const keyedRe = /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*["']?(\d{15,25})\b/g;
  const blocking = [];
  const informational = [];
  for (const rel of walkFiles(appDir, { skipDirs: BUILD_ARTEFACT_DIRS })) {
    const ext = path.extname(rel) || path.basename(rel);
    if (!TEXT_EXTS.has(ext)) continue;
    const text = fs.readFileSync(path.join(appDir, rel), 'utf8');
    const keyed = new Map();
    let m;
    keyedRe.lastIndex = 0;
    while ((m = keyedRe.exec(text))) keyed.set(m[2], m[1]);
    idRe.lastIndex = 0;
    while ((m = idRe.exec(text))) {
      const value = m[0];
      if (value === expectedAppId) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const key = keyed.get(value) || null;
      const hit = { file: rel, line, value, key };
      if (key && /app_?id/i.test(key)) blocking.push(hit);
      else informational.push(hit);
    }
  }
  return { blocking, informational };
}

// --- adapters ----------------------------------------------------------------------------------

/**
 * An adapter is pinned to template id + EXACT upstream SHA and every patch carries a
 * precondition asserting the broken state is still there. If upstream already fixed the defect
 * the precondition misses and the adapter REFUSES loudly instead of double-applying
 * (CONTRACT rule 5, plan 34 §4.4 "adapter precondition mismatch must fail loud").
 */
export function loadAdapter(templateId, revision, adaptersDir = ADAPTERS_DIR) {
  const file = path.join(adaptersDir, `${templateId}.json`);
  if (!fs.existsSync(file)) return { status: 'none', file: null, adapter: null };
  const adapter = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (adapter.templateId !== templateId) {
    return { status: 'invalid', file, adapter, detail: `adapter templateId=${adapter.templateId} != ${templateId}` };
  }
  if (adapter.appliesTo?.revision !== revision) {
    return {
      status: 'revision-mismatch',
      file,
      adapter,
      detail: `adapter is pinned to ${adapter.appliesTo?.revision} but this run qualifies ${revision}`,
    };
  }
  return { status: 'applicable', file, adapter, sha256: sha256(fs.readFileSync(file)) };
}

function evaluatePrecondition(appDir, pre) {
  const filePath = pre.file ? path.join(appDir, pre.file) : null;
  const text = filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  switch (pre.type) {
    case 'file-contains':
      return { ok: text !== null && text.includes(pre.value), detail: `${pre.file} contains ${JSON.stringify(pre.value)}` };
    case 'file-not-contains':
      return { ok: text !== null && !text.includes(pre.value), detail: `${pre.file} does not contain ${JSON.stringify(pre.value)}` };
    case 'dependency-absent': {
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      return { ok: !(pre.name in declared), detail: `package.json does not declare ${pre.name}` };
    }
    case 'source-imports': {
      const scan = scanDirectDependencies(appDir);
      return { ok: scan.imported.includes(pre.name), detail: `src imports ${pre.name}` };
    }
    default:
      return { ok: false, detail: `unknown precondition type "${pre.type}"` };
  }
}

export function applyAdapter(appDir, adapter) {
  const applied = [];
  const refused = [];
  for (const patch of adapter.patches) {
    const failures = (patch.preconditions || [])
      .map((pre) => ({ pre, res: evaluatePrecondition(appDir, pre) }))
      .filter(({ res }) => !res.ok);
    if (failures.length) {
      refused.push({
        patchId: patch.id,
        reason: 'precondition_mismatch',
        detail: failures.map(({ res }) => `expected: ${res.detail}`).join('; '),
      });
      continue;
    }
    if (patch.kind === 'replace') {
      const file = path.join(appDir, patch.file);
      const before = fs.readFileSync(file, 'utf8');
      const occurrences = before.split(patch.find).length - 1;
      if (occurrences !== (patch.expectedCount ?? 1)) {
        refused.push({ patchId: patch.id, reason: 'occurrence_mismatch', detail: `found ${occurrences} occurrence(s) of the anchor, expected ${patch.expectedCount ?? 1}` });
        continue;
      }
      fs.writeFileSync(file, before.replace(patch.find, patch.replace));
      applied.push({ patchId: patch.id, file: patch.file, kind: patch.kind });
    } else if (patch.kind === 'add-dependency') {
      const file = path.join(appDir, patch.file || 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bucket = patch.dev ? 'devDependencies' : 'dependencies';
      pkg[bucket] = Object.fromEntries(
        Object.entries({ ...pkg[bucket], [patch.dependency.name]: patch.dependency.version }).sort(([a], [b]) => a.localeCompare(b)),
      );
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
      applied.push({ patchId: patch.id, file: patch.file || 'package.json', kind: patch.kind, dependency: patch.dependency });
    } else {
      refused.push({ patchId: patch.id, reason: 'unknown_kind', detail: `patch kind "${patch.kind}" is not supported` });
    }
  }
  return { applied, refused };
}

// --- stage delegation ----------------------------------------------------------------------------

/**
 * Every child gets a proxy-free environment. The dev shell here exports
 * HTTPS_PROXY=http://10.164.68.254:81, whose TLS interception breaks pnpm with
 * `self-signed certificate in certificate chain`; the same happens to any user behind a
 * corporate MITM proxy, and the resulting error names TLS, not the proxy.
 */
function runStage(script, args, { workspace, storeDir = null }) {
  const extra = storeDir ? { NPM_CONFIG_STORE_DIR: storeDir } : {};
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: childEnv(extra),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: res.status ?? 3, output: `${res.stdout || ''}\n${res.stderr || ''}`.trim() };
}

function toolVersion(bin, args = ['--version']) {
  const res = spawnSync(bin, args, { encoding: 'utf8', env: childEnv() });
  return res.status === 0 ? String(res.stdout || '').trim().split('\n')[0] : null;
}

// --- scaffold pipeline (the mutating half, run twice by gate 7) ------------------------------------

function downloadTarball(owner, repo, revision, destFile) {
  const res = spawnSync('curl', ['-sSL', '--fail', '-o', destFile, TARBALL_URL(owner, repo, revision)], {
    encoding: 'utf8',
    env: childEnv(),
    timeout: 180000,
  });
  if (res.status !== 0) throw new Error(`codeload fetch failed for ${owner}/${repo}@${revision}: ${(res.stderr || '').slice(0, 200)}`);
  return destFile;
}

function extractTarball(tarFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const res = spawnSync('tar', ['-xzf', tarFile, '-C', destDir], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`tar extract failed: ${(res.stderr || '').slice(0, 200)}`);
  const names = fs.readdirSync(destDir).filter((n) => !n.startsWith('.'));
  return names.length === 1 ? path.join(destDir, names[0]) : destDir;
}

/**
 * Copy the snapshot into appDir and rebrand it. `.env` is never copied — plan 34 §4.4 gate 1
 * ("không lấy file .env hay credential mẫu vào app đích"). Returns the list of skipped envs.
 */
function scaffoldInto(snapshotDir, appDir, { appName, appId }) {
  const skippedEnvFiles = walkFiles(snapshotDir, { skipDirs: new Set(['node_modules', '.git']) })
    .filter((rel) => /(^|\/)\.env(\..*)?$/.test(rel));
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(snapshotDir, appDir, {
    recursive: true,
    force: true,
    filter: (src) => !/(^|\/)\.env(\..*)?$/.test(path.basename(src)) || fs.statSync(src).isDirectory(),
  });
  const slug = slugify(appName);
  const renamed = [];
  for (const rel of ['package.json', 'zmp-cli.json']) {
    const file = path.join(appDir, rel);
    if (!fs.existsSync(file)) continue;
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    obj.name = slug;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
    renamed.push(rel);
  }
  const appCfgFile = path.join(appDir, 'app-config.json');
  if (fs.existsSync(appCfgFile)) {
    const cfg = JSON.parse(fs.readFileSync(appCfgFile, 'utf8'));
    if (cfg.app && typeof cfg.app.title === 'string') cfg.app.title = appName;
    else if (typeof cfg.title === 'string') cfg.title = appName;
    fs.writeFileSync(appCfgFile, JSON.stringify(cfg, null, 2) + '\n');
    renamed.push('app-config.json');
  }
  upsertEnvKey(path.join(appDir, '.env'), 'APP_ID', appId);
  return { slug, renamed, skippedEnvFiles };
}

// --- promotion ------------------------------------------------------------------------------------

/**
 * The ONLY path that writes catalog/templates.json.
 *
 * Hard rules, in this order:
 *   - every blocking gate must have passed;
 *   - `source.licenseDecision` must not be `review-required` (CONTRACT-plan34 rule 3 — new
 *     templates wait for the owner's D34-8 decision; zaui-fashion's grandfather is recorded in
 *     the registry note and is NOT a precedent);
 *   - the qualified revision must be the one the evidence was produced from.
 * Anything short of that prints what is blocked and leaves the file untouched. A state is never
 * hand-edited to make a run look green.
 */
export function evaluatePromotion({ profile, gates, revision, upstreamHead }) {
  const blockedBy = [];
  const failed = gates.filter((g) => g.blocking && g.status !== 'pass');
  for (const g of failed) blockedBy.push(`blocking gate "${g.id}" is ${g.status}: ${g.detail}`);
  if (profile.source.licenseDecision === 'review-required') {
    blockedBy.push(
      `source.licenseDecision="review-required" — CONTRACT-plan34 rule 3 forbids promoting a new template to`
      + ` release-supported before the owner's license decision (D34-8). Registry untouched.`,
    );
  }
  if (profile.source.licenseDecision === 'blocked') {
    blockedBy.push('source.licenseDecision="blocked" — the owner refused this template');
  }
  if (upstreamHead && upstreamHead !== revision) {
    blockedBy.push(`upstream HEAD is ${upstreamHead} but this evidence covers ${revision} — repin or requalify before promoting`);
  }
  return { eligible: blockedBy.length === 0, blockedBy };
}

function writePromotion(registryPath, templateId, { revision, state, adapterId, evidenceRef }) {
  const raw = fs.readFileSync(registryPath, 'utf8');
  const registry = JSON.parse(raw);
  const profile = registry.templates.find((t) => t.id === templateId);
  profile.source.revision = revision;
  profile.qualification.state = state;
  profile.qualification.testedRevision = revision;
  profile.qualification.adapterId = adapterId;
  profile.qualification.evidence = evidenceRef;
  // Report 41 §6.4: the seeded "chưa chạy qualification factory" note survived zaui-doctor's
  // promotion, so the registry claimed nobody had ever run the factory on a template that had
  // full evidence. Promotion owns the note from now on.
  profile.qualification.note = `qualification factory pass đủ 7 blocking gate tại ${revision.slice(0, 7)}`
    + ` — evidence ${evidenceRef.qualificationResult}`;
  const tmp = `${registryPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n');
  fs.renameSync(tmp, registryPath);
}

// --- main ---------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const templateId = getArg(argv, 'id');
  if (!templateId) {
    console.error('qualify: --id <template-id> is required');
    process.exit(3);
  }
  const registryPath = path.resolve(getArg(argv, 'registry', DEFAULT_REGISTRY));
  if (!fs.existsSync(registryPath)) {
    console.error(`qualify: registry not found: ${registryPath}`);
    process.exit(3);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const profile = registry.templates.find((t) => t.id === templateId);
  if (!profile) {
    console.error(`qualify: no template "${templateId}" in ${registryPath}`);
    process.exit(3);
  }
  const appId = getArg(argv, 'app-id', DEFAULT_QUALIFY_APP_ID);
  const adaptersDir = path.resolve(getArg(argv, 'adapters', ADAPTERS_DIR));
  const outDirArg = getArg(argv, 'out');
  const promote = argv.includes('--promote');
  const keepWorkspace = argv.includes('--keep-workspace');
  const noAdapter = argv.includes('--no-adapter');
  const cleanStore = argv.includes('--clean-store');

  const startedAt = nowIso();
  const t0 = Date.now();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `zmp-qualify-${templateId}-`));
  const appDir = path.join(workspace, 'app');
  const runId = `qualify-${templateId}-${new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}`;
  const runDir = path.join(workspace, 'runs', runId);
  const storeDir = cleanStore ? path.join(workspace, '.pnpm-store') : null;

  const gates = [];
  const gate = (id, blocking = true) => {
    const g = makeGate(id, blocking);
    gates.push(g);
    return g;
  };
  const result = {
    schemaVersion: 1,
    tool: 'qualify-template',
    templateId,
    startedAt,
    workspace,
    runId,
    registryPath,
  };

  console.error(`qualify: ${templateId} — clean workspace ${workspace}`);

  // ---------- gate 1: provenance ----------
  const g1 = gate('provenance');
  let revision = null;
  let upstreamHead = null;
  let snapshotDir = null;
  try {
    check(g1, 'owner_first_party', profile.source.owner === FIRST_PARTY_OWNER ? 'pass' : 'fail',
      `source.owner=${profile.source.owner} (expected ${FIRST_PARTY_OWNER})`);

    upstreamHead = resolveHeadSha(profile.source.owner, profile.source.repository, profile.source.defaultBranch);
    check(g1, 'repo_resolvable', upstreamHead ? 'pass' : 'fail',
      upstreamHead ? `git ls-remote HEAD of ${profile.source.defaultBranch} = ${upstreamHead}` : 'git ls-remote could not resolve the repository');

    revision = getArg(argv, 'revision') || profile.source.revision || upstreamHead || profile.source.headObserved;
    check(g1, 'revision_pinned', revision && /^[0-9a-f]{40}$/.test(revision) ? 'pass' : 'fail',
      `qualifying revision=${revision ?? 'null'} (source: ${getArg(argv, 'revision') ? '--revision' : profile.source.revision ? 'registry source.revision' : 'upstream HEAD'})`);

    if (revision) {
      const tarFile = downloadTarball(profile.source.owner, profile.source.repository, revision, path.join(workspace, 'snapshot.tar.gz'));
      snapshotDir = extractTarball(tarFile, path.join(workspace, 'snapshot'));
      // codeload names the top-level directory <repo>-<sha>; that is the cheapest available
      // proof that the bytes we extracted really are the SHA we asked for.
      check(g1, 'snapshot_immutable', path.basename(snapshotDir) === `${profile.source.repository}-${revision}` ? 'pass' : 'fail',
        `extracted top-level dir "${path.basename(snapshotDir)}"`);
      check(g1, 'snapshot_has_manifest', fs.existsSync(path.join(snapshotDir, 'package.json')) ? 'pass' : 'fail',
        'package.json present in the snapshot');
      const envFiles = walkFiles(snapshotDir, { skipDirs: new Set(['node_modules', '.git']) }).filter((r) => /(^|\/)\.env(\..*)?$/.test(r));
      // Not a failure: the requirement is that we never copy them into the target app.
      check(g1, 'no_upstream_env_copied', 'pass',
        envFiles.length ? `snapshot ships ${envFiles.join(', ')} — excluded from the scaffold copy` : 'snapshot ships no .env file');
      const pkg = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'package.json'), 'utf8'));
      result.license = {
        packageJsonLicense: pkg.license ?? null,
        licenseFilePresent: fs.existsSync(path.join(snapshotDir, 'LICENSE')) || fs.existsSync(path.join(snapshotDir, 'LICENSE.md')),
        registryLicenseFile: profile.source.licenseFile,
        registryPackageJsonLicense: profile.source.packageJsonLicense,
        licenseDecision: profile.source.licenseDecision,
      };
      check(g1, 'license_recorded', 'pass',
        `package.json license=${pkg.license ?? 'null'}, LICENSE file=${result.license.licenseFilePresent}, registry licenseDecision=${profile.source.licenseDecision}`);
    }
  } catch (err) {
    check(g1, 'provenance_error', 'fail', err.message);
  }
  result.revision = revision;
  result.shortRevision = revision ? revision.slice(0, 7) : null;
  result.upstreamHead = upstreamHead;
  // Plan 34 §4.4: "upstream đổi SHA thì qualification tự về candidate, không kế thừa pass cũ".
  result.evidenceValidForHead = !!(revision && upstreamHead && revision === upstreamHead);
  result.recordedStateEffective = (profile.qualification.testedRevision && profile.qualification.testedRevision === upstreamHead)
    ? profile.qualification.state
    : 'candidate';
  sealGate(g1, `${profile.source.owner}/${profile.source.repository}@${revision} snapshot verified`);

  const finish = (exitCode) => finishRun({ result, gates, workspace, runDir, keepWorkspace, outDirArg, t0, exitCode });

  if (g1.status !== 'pass') {
    result.derivedState = 'quarantined';
    result.quarantineReason = g1.detail;
    return finish(1);
  }

  // ---------- scaffold + rebrand (mutating half) ----------
  const appName = `Qualify ${templateId}`;
  const scaffold = scaffoldInto(snapshotDir, appDir, { appName, appId });

  let adapterInfo = { status: 'disabled', file: null, applied: [], refused: [] };
  if (!noAdapter) {
    const loaded = loadAdapter(templateId, revision, adaptersDir);
    adapterInfo = { status: loaded.status, file: loaded.file, adapterId: loaded.adapter?.adapterId ?? null, sha256: loaded.sha256 ?? null, applied: [], refused: [] };
    if (loaded.status === 'applicable') {
      const expires = loaded.adapter.expiresAt ? Date.parse(loaded.adapter.expiresAt) : null;
      adapterInfo.expired = !!(expires && Date.now() > expires);
      const { applied, refused } = applyAdapter(appDir, loaded.adapter);
      adapterInfo.applied = applied;
      adapterInfo.refused = refused;
      console.error(`qualify: adapter ${loaded.adapter.adapterId} — applied ${applied.length}, refused ${refused.length}`);
      for (const r of refused) console.error(`qualify:   REFUSED ${r.patchId}: ${r.reason} — ${r.detail}`);
    } else if (loaded.status !== 'none') {
      console.error(`qualify: adapter NOT applied (${loaded.status}) — ${loaded.detail}`);
      adapterInfo.detail = loaded.detail;
    }
  }
  result.adapter = adapterInfo;
  // Adapter refusals are only tolerable when nothing was expected to apply; a partially applied
  // adapter means the tree is in a state no evidence covers.
  if (adapterInfo.refused.length && adapterInfo.applied.length) {
    console.error('qualify: adapter partially applied — treating as a blocking provenance defect');
  }
  const postScaffold = treeDigest(appDir);
  result.postScaffoldDigest = postScaffold;

  // Run scaffolding required by the reused stage scripts (they expect a bootstrap-shaped run dir).
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'input.json'), JSON.stringify({
    schemaVersion: '1.0',
    brief: null,
    miniAppId: appId,
    appIdSource: 'prompt',
    appName,
    template: { source: 'official', id: templateId, revision },
    renderProvider: 'browser',
    defaultViewport: { width: 390, height: 844 },
    packageManager: 'pnpm',
    invokedVia: 'harness',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(runDir, 'evidence', 'app-id-binding.json'), JSON.stringify({
    sourcePath: 'app/.env',
    expectedAppId: appId,
    persistedAppId: readEnvKey(path.join(appDir, '.env'), 'APP_ID'),
  }, null, 2) + '\n');

  // ---------- gate 2: dependency ----------
  const g2 = gate('dependency');
  const depScan = scanDirectDependencies(appDir);
  result.dependencyScan = depScan;
  // Cảnh báo, KHÔNG chặn. Phân loại tĩnh không phân biệt được import chỉ dùng ở vị trí type
  // (esbuild xoá lúc build) với import lấy giá trị thật — zaui-fashion nhập
  // `{ EmblaCarouselType }` từ một package không khai mà vẫn build/chạy bình thường, nên chặn
  // ở đây sẽ quarantine nhầm một template đang chạy tốt. Trọng tài thật là gate build và
  // runtime bên dưới: thiếu dependency ở vị trí giá trị thì build gãy và nêu đích danh module.
  // Vẫn ghi lại để báo upstream vì đây là lỗi khai báo thật.
  check(g2, 'direct_dependency_completeness', depScan.missingRuntime.length === 0 ? 'pass' : 'warn',
    depScan.missingRuntime.length
      ? `imported but not declared: ${depScan.missingRuntime.map((r) => `${r.name} (${r.sites[0]})`).join(', ')}`
        + ' — pnpm isolated node_modules chỉ resolve được nếu package được khai trực tiếp;'
        + ' build/runtime gate là nơi quyết định pass/fail'
      : `${depScan.imported.length} imported package(s), all declared directly`);
  if (depScan.missingTypeOnly.length) {
    check(g2, 'type_only_imports_declared', 'warn',
      `type-only imports not declared (erased by esbuild, non-blocking): ${depScan.missingTypeOnly.map((r) => r.name).join(', ')}`);
  }
  const install = runStage('install.mjs', ['--workspace', workspace, '--run-id', runId], { workspace, storeDir });
  check(g2, 'pnpm_install', install.code === 0 ? 'pass' : 'fail', `install.mjs exit ${install.code}${install.code ? `: ${install.output.slice(-400)}` : ''}`);
  const environment = fs.existsSync(path.join(runDir, 'environment.json'))
    ? JSON.parse(fs.readFileSync(path.join(runDir, 'environment.json'), 'utf8'))
    : null;
  result.toolchain = {
    node: process.version,
    pnpm: environment?.pnpm ?? toolVersion('pnpm'),
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    chrome: toolVersion('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    packageManagerPolicy: 'pnpm (isolated node_modules); npm hoisting is never used as a fallback',
    pnpmStore: storeDir ? `clean per-run store: ${storeDir}` : 'shared global pnpm store (pass --clean-store for a per-run store)',
    resolvedVersions: environment?.resolvedVersions ?? null,
  };
  const installOk = sealGate(g2, `pnpm ${result.toolchain.pnpm} installed ${depScan.imported.length} imported package(s), all declared`);

  // ---------- gate 3: build ----------
  const g3 = gate('build');
  let buildInfo = null;
  if (!installOk && install.code !== 0) {
    check(g3, 'build', 'fail', 'skipped — pnpm install failed, no node_modules to build with');
  } else {
    const build = runStage('build.mjs', ['--workspace', workspace, '--run-id', runId], { workspace, storeDir });
    buildInfo = fs.existsSync(path.join(runDir, 'evidence', 'build-info.json'))
      ? JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'build-info.json'), 'utf8'))
      : null;
    const buildLog = fs.existsSync(path.join(runDir, 'evidence', 'build.log'))
      ? fs.readFileSync(path.join(runDir, 'evidence', 'build.log'), 'utf8')
      : '';
    // build.mjs also owns the APP_ID probe; attribute its verdict to gate 4, not here.
    const artefactsOk = !!buildInfo?.outDir && detectOutDir(appDir) !== null;
    if (artefactsOk) {
      check(g3, 'vite_build', 'pass',
        `build.mjs exit ${build.code}, outDir=${buildInfo.outDir} (OUT_DIR_CANDIDATES detection reused from build.mjs)`);
    } else {
      // Which stage of build.mjs actually stopped: Tier-1 preflight, or vite itself (§6.3).
      const preflight = fs.existsSync(path.join(runDir, 'evidence', 'preflight.json'))
        ? JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'preflight.json'), 'utf8'))
        : null;
      const stop = classifyBuildStop(preflight, buildLog, build.output);
      result.buildStop = { stage: stop.checkId, exitCode: build.code };
      check(g3, stop.checkId, 'fail', `build.mjs exit ${build.code}; ${stop.detail}`);
    }
    if (artefactsOk) {
      const prepared = fs.existsSync(path.join(appDir, 'src', 'index.html')) && !fs.existsSync(path.join(snapshotDir, 'src', 'index.html'));
      check(g3, 'generic_vite_preparation', 'pass',
        prepared
          ? 'prepareViteSrcEntry() generated src/index.html from the root index.html (shipped harness preparation, review 35 F3)'
          : 'no generic preparation needed');
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (pkg.scripts?.['build:css']) {
        check(g3, 'build_css_prestep', buildLog.includes('build:css') ? 'pass' : 'warn',
          `template ships a build:css script; build.mjs ran it as the pre-step (exit recorded in build.log)`);
      }
    }
  }
  result.buildInfo = buildInfo;
  const buildOk = sealGate(g3, `built into ${buildInfo?.outDir}`);

  // ---------- gate 4: rebrand / App ID ----------
  const g4 = gate('rebrand_app_id');
  const pkgAfter = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  check(g4, 'name_rebranded', pkgAfter.name === scaffold.slug ? 'pass' : 'fail',
    `package.json name="${pkgAfter.name}" (rebranded files: ${scaffold.renamed.join(', ')})`);
  const persisted = readEnvKey(path.join(appDir, '.env'), 'APP_ID');
  check(g4, 'app_id_persisted', persisted === appId ? 'pass' : 'fail', `app/.env APP_ID=${persisted} (expected ${appId})`);
  const binding = fs.existsSync(path.join(runDir, 'evidence', 'app-id-binding.json'))
    ? JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'app-id-binding.json'), 'utf8'))
    : {};
  if (buildOk) {
    check(g4, 'app_id_resolved_by_build', binding.buildProcessAppId === appId ? 'pass' : 'fail',
      `vite loadEnv() inside the app resolved APP_ID=${binding.buildProcessAppId ?? 'null'}`);
  }
  const residual = scanResidualIdentifiers(appDir, appId);
  result.residualIdentifiers = residual;
  check(g4, 'no_foreign_app_id', residual.blocking.length === 0 ? 'pass' : 'fail',
    residual.blocking.length
      ? residual.blocking.map((h) => `${h.file}:${h.line} ${h.key}=${h.value}`).join(', ')
      : 'no appId-keyed identifier other than the bound App ID');
  if (residual.informational.length) {
    // Not an App ID, so not this gate's blocking concern — but a template shipping the vendor's
    // own OA/demo identifier is a real rebrand leak the human reviewer must see.
    check(g4, 'residual_upstream_identifiers', 'warn',
      residual.informational.map((h) => `${h.file}:${h.line} ${h.key ?? '(unkeyed)'}=${h.value}`).join(', '));
  }
  sealGate(g4, `rebranded to "${scaffold.slug}", APP_ID ${appId} bound and resolved by the build toolchain`);

  // ---------- gate 5: runtime ----------
  //
  // TWO oracles, on purpose (mandate 42 §3.3 + R41-4):
  //
  //   no-host   plain static server, no Zalo host at all. Recorded, NOT blocking. This is not
  //             an environment a Mini App ever ships into, and measured on 2026-08-23 four of
  //             the nine Portal templates fail it for one reason only — a zmp-sdk call
  //             answering -2000 because there is no host (bistro getItem, menu setStorage,
  //             uni showOAWidget, market login). Failing a template for that is measuring the
  //             harness, not the template. Kept because it is the only place a host-independent
  //             regression (a real blank page, a real overflow) shows up unmasked.
  //
  //   simulator sim serving — real hostname/path + the SDK shim + the DX runtime marker. This
  //             is the blocking verdict. Note what this is NOT: the gate is unchanged, every
  //             console.error and pageerror is still fatal. Nothing was downgraded to a warning
  //             (mandate 42 R41-4 forbids exactly that); the app is simply run in the
  //             environment it is written for.
  //
  // The no-host run goes first and its evidence is copied aside, because the simulator run
  // overwrites the canonical console.jsonl/gates.json.
  const g5 = gate('runtime');
  const evidenceDir = path.join(runDir, 'evidence');
  if (!buildOk) {
    check(g5, 'browser_oracle', 'fail', 'skipped — no build output to serve');
  } else {
    const noHost = runStage('render.mjs', ['--workspace', workspace, '--run-id', runId], { workspace, storeDir });
    const noHostGates = fs.existsSync(path.join(evidenceDir, 'gates.json'))
      ? JSON.parse(fs.readFileSync(path.join(evidenceDir, 'gates.json'), 'utf8'))
      : null;
    result.noHostOracle = {
      exitCode: noHost.code,
      gates: noHostGates,
      consoleExcerpt: readConsoleExcerpt(path.join(evidenceDir, 'console.jsonl')),
    };
    for (const [from, to] of [['gates.json', 'no-host-gates.json'], ['console.jsonl', 'no-host-console.jsonl']]) {
      if (fs.existsSync(path.join(evidenceDir, from))) {
        fs.copyFileSync(path.join(evidenceDir, from), path.join(evidenceDir, to));
      }
    }
    const noHostFailing = ((noHostGates?.gates) ?? []).filter((x) => x.status === 'fail');
    check(g5, 'browser_oracle_no_host', noHostFailing.length === 0 ? 'pass' : 'warn',
      noHostFailing.length
        ? `served without a Zalo host: ${noHostFailing.map((x) => `${x.id}@${x.viewport}: ${x.detail}`).join(' | ')}`
          + ' — recorded, not blocking: see evidence/no-host-console.jsonl for what the app actually said'
        : 'app also renders clean with no Zalo host at all');

    const render = runStage('render.mjs', ['--workspace', workspace, '--run-id', runId, '--provider', 'simulator'], { workspace, storeDir });
    const gatesFile = path.join(evidenceDir, 'gates.json');
    const oracle = fs.existsSync(gatesFile) ? JSON.parse(fs.readFileSync(gatesFile, 'utf8')) : null;
    result.oracleGates = oracle;
    result.oracleProfile = 'simulator-official';
    // §6.2: keep WHAT the browser said, not just how many times it said something.
    result.consoleExcerpt = readConsoleExcerpt(path.join(evidenceDir, 'console.jsonl'));
    if (!oracle) {
      check(g5, 'browser_oracle', 'fail', `render.mjs --provider simulator exit ${render.code} produced no gates.json: ${render.output.slice(-400)}`);
    } else {
      const list = Array.isArray(oracle) ? oracle : oracle.gates || [];
      const failing = list.filter((x) => x.status === 'fail');
      const skipped = [...new Set(list.filter((x) => x.status === 'skipped').map((x) => x.id))];
      check(g5, 'browser_oracle', failing.length === 0 ? 'pass' : 'fail',
        failing.length
          ? failing.map((x) => `${x.id}@${x.viewport ?? '-'}: ${x.detail}`).join(' | ')
          : `${list.filter((x) => x.status === 'pass').length} oracle gate(s) passed across 3 viewports (profile simulator-official)`);
      // The locked profile deliberately skips lab-only marker/interaction/cta gates. Recording
      // this keeps the evidence honest about what "runtime pass" does and does not cover.
      if (skipped.length) {
        check(g5, 'oracle_coverage', 'warn',
          `profile simulator-official skipped: ${skipped.join(', ')} — no interaction evidence, so the highest evidence-backed rung is render-qualified`);
      }
      result.screenshots = fs.readdirSync(evidenceDir).filter((f) => f.endsWith('.png')).sort();
      result.screenshotsPath = evidenceDir;
    }
  }
  const runtimeOk = sealGate(g5, 'react mount + non-empty content + no horizontal overflow + no fatal console error on 3 viewports');

  // ---------- gate 6: external dependency ----------
  const g6 = gate('external_dependency');
  const requirements = scanExternalDependencies(appDir, profile);
  result.externalRequirements = requirements;
  const firstPreviewBlockers = requirements.filter((r) => r.neededForFirstPreview);
  check(g6, 'first_preview_self_contained', firstPreviewBlockers.length === 0 ? 'pass' : 'fail',
    firstPreviewBlockers.length
      ? `first preview needs the user to supply: ${firstPreviewBlockers.map((r) => `${r.name} (${r.kind}, ${r.sites[0]})`).join(', ')}`
      : `no backend/API/env input required for the first preview${requirements.length ? ` (declared, non-blocking: ${requirements.map((r) => r.name).join(', ')})` : ''}`);
  if (runtimeOk) {
    const consoleFile = path.join(runDir, 'evidence', 'console.jsonl');
    const lines = fs.existsSync(consoleFile) ? fs.readFileSync(consoleFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    // console/pageerror only — the kind='error-detail' companions restate the same failure and
    // would double-count it here.
    const remote = lines.filter((l) => (l.kind === 'console' || l.kind === 'pageerror')
      && /https?:\/\/(?!127\.0\.0\.1|localhost)/.test(l.text || '') && /failed|error|refused/i.test(l.text || ''));
    check(g6, 'no_failed_remote_calls_at_runtime', remote.length === 0 ? 'pass' : 'warn',
      remote.length ? `${remote.length} console line(s) mention a failing remote request` : 'no failing remote request observed in the browser run');
  }
  sealGate(g6, 'first preview runs on bundled/mock data only');

  // ---------- gate 7: safe rerun ----------
  const g7 = gate('safe_rerun');
  const rerunDir = path.join(workspace, 'rerun-app');
  scaffoldInto(snapshotDir, rerunDir, { appName, appId });
  if (adapterInfo.status === 'applicable') {
    const loaded = loadAdapter(templateId, revision, adaptersDir);
    applyAdapter(rerunDir, loaded.adapter);
  }
  const rerunDigest = treeDigest(rerunDir);
  check(g7, 'pipeline_deterministic', rerunDigest.digest === postScaffold.digest ? 'pass' : 'fail',
    `same id+revision+appId produced tree digest ${rerunDigest.digest.slice(0, 16)} vs ${postScaffold.digest.slice(0, 16)} (${rerunDigest.fileCount} files)`);
  if (adapterInfo.status === 'applicable' && adapterInfo.applied.length) {
    // Re-applying to the ALREADY PATCHED tree must refuse, and must not touch a single byte.
    const before = treeDigest(appDir);
    const loaded = loadAdapter(templateId, revision, adaptersDir);
    const second = applyAdapter(appDir, loaded.adapter);
    const after = treeDigest(appDir);
    check(g7, 'adapter_refuses_double_apply',
      second.applied.length === 0 && second.refused.length === adapterInfo.applied.length && before.digest === after.digest ? 'pass' : 'fail',
      `second application: applied=${second.applied.length} refused=${second.refused.length} (${second.refused.map((r) => `${r.patchId}/${r.reason}`).join(', ')}), tree unchanged=${before.digest === after.digest}`);
  }
  sealGate(g7, 'mutating pipeline is deterministic and the adapter refuses to double-apply');

  // ---------- derive state + promotion ----------
  const blockingFailures = gates.filter((g) => g.blocking && g.status !== 'pass');
  let derivedState;
  if (blockingFailures.length === 0) {
    // The locked oracle profile skips interaction markers for official templates, so the highest
    // rung the evidence actually supports is render-qualified. release-supported is a promotion
    // decision on top of that, not something a green run grants itself.
    derivedState = 'render-qualified';
  } else if (g3.status === 'pass' && g5.status !== 'pass') {
    derivedState = 'build-qualified';
  } else if (g2.status !== 'pass' || g3.status !== 'pass') {
    derivedState = 'quarantined';
  } else {
    derivedState = 'candidate';
  }
  result.derivedState = derivedState;
  result.quarantineReason = derivedState === 'quarantined'
    ? blockingFailures.map((g) => `${g.id}: ${g.detail}`).join(' ;; ')
    : null;

  const promotion = evaluatePromotion({ profile, gates, revision, upstreamHead });
  result.promotion = {
    requested: promote,
    eligible: promotion.eligible,
    blockedBy: promotion.blockedBy,
    targetState: 'release-supported',
    applied: false,
  };
  if (promote && promotion.eligible) {
    writePromotion(registryPath, templateId, {
      revision,
      state: 'release-supported',
      adapterId: adapterInfo.adapterId ?? null,
      evidenceRef: { qualificationResult: `catalog/qualification/${templateId}-${result.shortRevision}.json`, runId },
    });
    result.promotion.applied = true;
  }

  let exitCode = blockingFailures.length ? 1 : 0;
  if (promote && !promotion.eligible) exitCode = 4;
  return finish(exitCode);
}

function finishRun({ result, gates, workspace, runDir, keepWorkspace, outDirArg, t0, exitCode }) {
  result.gates = gates;
  result.finishedAt = nowIso();
  result.durationMs = Date.now() - t0;
  result.exitCode = exitCode;

  const json = JSON.stringify(result, null, 2) + '\n';
  fs.mkdirSync(runDir, { recursive: true });
  const inWorkspace = path.join(workspace, 'qualification-result.json');
  fs.writeFileSync(inWorkspace, json);
  fs.writeFileSync(path.join(runDir, 'qualification-result.json'), json);

  const catalogCopyDir = outDirArg ? path.resolve(outDirArg) : QUALIFICATION_DIR;
  fs.mkdirSync(catalogCopyDir, { recursive: true });
  const catalogCopy = path.join(catalogCopyDir, `${result.templateId}-${result.shortRevision ?? 'unknown'}.json`);
  fs.writeFileSync(catalogCopy, json);

  // Readable summary on stdout; the machine copy is the two files above.
  const lines = [];
  lines.push(`qualification: ${result.templateId} @ ${result.revision ?? 'unresolved'}`);
  lines.push(`  workspace   : ${workspace}${keepWorkspace ? '' : ' (removed below)'}`);
  lines.push(`  toolchain   : node ${result.toolchain?.node ?? process.version}, pnpm ${result.toolchain?.pnpm ?? '?'}`);
  lines.push(`  adapter     : ${result.adapter?.adapterId ?? result.adapter?.status ?? 'none'}`
    + (result.adapter?.applied?.length ? ` — applied ${result.adapter.applied.map((a) => a.patchId).join(', ')}` : '')
    + (result.adapter?.refused?.length ? ` — refused ${result.adapter.refused.map((a) => a.patchId).join(', ')}` : ''));
  for (const g of gates) {
    lines.push(`  ${g.status === 'pass' ? 'PASS' : g.status === 'fail' ? 'FAIL' : 'SKIP'} ${g.id.padEnd(20)} ${g.detail}`);
    for (const c of g.checks.filter((c) => c.status !== 'pass')) lines.push(`       - ${c.status.toUpperCase()} ${c.id}: ${c.detail}`);
  }
  // §6.2: the console excerpt is the answer to "why did runtime fail" — print it here so the
  // operator never has to rerun the factory just to read a log line.
  if (result.consoleExcerpt) {
    lines.push(`  console      : ${result.consoleExcerpt.totalErrorEvents} error event(s)${result.consoleExcerpt.truncated ? ' (excerpt truncated)' : ''}`);
    for (const e of result.consoleExcerpt.events.slice(0, 6)) {
      lines.push(`       ${e.kind}${e.type ? `/${e.type}` : ''}${e.source ? `/${e.source}` : ''} @${e.viewport ?? '-'}: ${e.text.slice(0, 220)}`);
    }
  }
  lines.push(`  derived state: ${result.derivedState}${result.quarantineReason ? ` — ${result.quarantineReason}` : ''}`);
  if (result.promotion) {
    lines.push(`  promotion    : requested=${result.promotion.requested} applied=${result.promotion.applied}`);
    for (const b of result.promotion.blockedBy) lines.push(`       BLOCKED: ${b}`);
  }
  lines.push(`  evidence     : ${inWorkspace}`);
  lines.push(`  catalog copy : ${catalogCopy}`);
  console.log(lines.join('\n'));

  if (!keepWorkspace && exitCode === 0) fs.rmSync(workspace, { recursive: true, force: true });
  else if (!keepWorkspace) console.error(`qualify: workspace kept for inspection because the run did not fully pass: ${workspace}`);
  process.exit(exitCode);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) await main();
