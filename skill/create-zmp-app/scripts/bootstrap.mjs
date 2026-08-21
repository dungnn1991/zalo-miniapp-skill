#!/usr/bin/env node
// bootstrap.mjs — stage 1 of the create-zmp-app pipeline (Subagent A).
// Parse + normalize input, resolve the Mini App ID per plan §5.2, scaffold app/ from the
// template, bind APP_ID into app/.env (key-level), read back and exact-compare.
//
// CLI:
//   node bootstrap.mjs --brief <text> [--app-id <id>] [--app-name <name>]
//                      [--confirm-app-id <id>] [--template official:<id>]
//                      [--invoked-via slash-command|codex-skill|natural-language|harness]
//                      [--workspace <dir>]
//
// --template official:<id> (Phase 2.5, opt-in): scaffold from the platform's official
// template catalog (lab.config.json `officialTemplates` — authoritative). Also activated
// when the brief contains an opt-in phrase; catalog keywords then map the brief to an id
// in declaration order (first match wins). Opt-in without a match -> exit 3 with a final
// stdout JSON {"status":"needs_template_choice","catalog":[...]} — never guessed, never a
// silent fallback. Without opt-in the lab template path is byte-identical to before.
//
// --confirm-app-id: explicit, user-confirmed choice of the PROMPT App ID after an
// app_id_conflict. Must equal the resolved prompt App ID byte-for-byte; only then may a
// conflicting app/.env value be overwritten (key-level upsert, still read-back verified).
// This is user-authorized, never silent. Misuse (no prompt ID, or mismatch) exits 3.
//
// Exit codes (lab.config.json): 0 pass · 1 gate fail (finding recorded) ·
// 2 needs_input (nothing mutated) · 3 precondition/config error.
// Last stdout line: {"runId":"...","status":"ok"|"needs_input"|"conflict"}.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TEMPLATE_DIR, loadLabConfig, resolveWorkspace, getArg } from './lib/paths.mjs';
import { newRunId, openRun, fingerprint } from './lib/run-context.mjs';
import { redactText } from './lib/redact.mjs';

const INVOKED_VIA = ['slash-command', 'codex-skill', 'natural-language', 'harness'];

function die(message, code = 3) {
  process.stderr.write(`bootstrap: ${message}\n`);
  process.exit(code);
}

// --- App ID parsing ------------------------------------------------------------------
// Plan §3/§5.2: keep the ID a string (never Number(), leading zeros preserved).
// Only trim whitespace and strip ONE pair of surrounding quotes.
function normalizeAppId(raw) {
  if (raw === null || raw === undefined) return null;
  let v = String(raw).trim();
  const m = /^"(.*)"$/s.exec(v) || /^'(.*)'$/s.exec(v);
  if (m) v = m[1].trim();
  return v.length > 0 ? v : null;
}

// Accept appId="X" / appid=X / miniAppId=X embedded in the brief when --app-id is absent.
// The brief itself is stored as given; we only extract the value.
function extractAppIdFromBrief(brief) {
  if (!brief) return null;
  const m = /\b(?:mini[_-]?app[_-]?id|app[_-]?id|appid)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;"']+)/i.exec(brief);
  return m ? normalizeAppId(m[1]) : null;
}

// Key-level .env parsing: first APP_ID line wins; tolerate quotes/whitespace/export.
function parseEnvValue(content, key) {
  for (const line of content.split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`).exec(line);
    if (m) return normalizeAppId(m[1]);
  }
  return null;
}

// Key-level upsert: replace only the APP_ID line, preserve every other line and their order.
// Never rewrites unrelated keys; creates the file if missing.
function upsertEnvKey(file, key, value) {
  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// --- Variant classification ----------------------------------------------------------
const CLOTHING_PHRASES = ['quần áo', 'thời trang', 'shop đồ', 'bán đồ mặc', 'fashion', 'clothing', 'apparel', 'clothes'];
const CLOTHING_WORDS = ['áo', 'quần', 'váy', 'đầm', 'outfit'];

// Đa ngôn ngữ (config officialTemplates.matchNormalization): brief VN có dấu/không dấu/EN
// đều phải khớp — normalize CẢ HAI CHIỀU: lowercase + NFD bỏ dấu + đ→d.
// 'quần áo' / 'quan ao' / 'Quần Áo' → 'quan ao'. Chỉ dùng cho SO KHỚP — input.json giữ nguyên văn.
function normalizeVi(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}
// Multi-word phrase: substring trên chuỗi normalized (an toàn). Single word: word-boundary
// trên chuỗi normalized để tránh false positive kiểu 'dam'/'vay' lẫn trong từ EN khác.
function matchNormalized(normText, keyword) {
  const nk = normalizeVi(keyword);
  if (nk.includes(' ')) return normText.includes(nk);
  return new RegExp(`(^|[^a-z0-9])${nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(normText);
}

function classifyVariant(brief, allowedVariants) {
  let variant = 'neutral';
  if (brief) {
    const t = brief.toLowerCase();
    const nt = normalizeVi(brief);
    if (
      CLOTHING_PHRASES.some((p) => matchNormalized(nt, p)) ||
      // từ đơn giữ matching CÓ DẤU (bỏ dấu các từ ngắn này sẽ va chạm từ EN: 'dam', 'vay')
      CLOTHING_WORDS.some((w) => new RegExp(`(^|[^\\p{L}])${w}($|[^\\p{L}])`, 'u').test(t))
    ) {
      variant = 'clothing-store';
    }
  }
  return allowedVariants.includes(variant) ? variant : 'neutral';
}

// --- Official templates (Phase 2.5, opt-in) ------------------------------------------
// Catalog, opt-in phrases, keyword mapping and tarball URL pattern are LOCKED in
// lab.config.json `officialTemplates`. Modes: lab (default) | official | ambiguous.
function resolveTemplateSelection(argv, brief, config) {
  const ot = config.officialTemplates;
  const explicit = getArg(argv, 'template', null);
  if (explicit !== null) {
    if (!ot) die('lab.config.json has no officialTemplates section; --template unsupported');
    const ids = ot.catalog.map((c) => c.id);
    const m = /^official:(.+)$/.exec(explicit.trim());
    if (!m) die(`invalid --template "${explicit}" (expected official:<id>; ids: ${ids.join(', ')})`);
    const id = m[1].trim();
    const entry = ot.catalog.find((c) => c.id === id);
    if (!entry) die(`unknown official template id "${id}"; valid ids: ${ids.join(', ')}`);
    return { mode: 'official', entry };
  }
  if (!ot || !brief) return { mode: 'lab' };
  // normalize hai chiều (matchNormalization): 'dung mau co san' == 'dùng mẫu có sẵn'
  const nt = normalizeVi(brief);
  const optIn = ot.optInPhrases.some((p) => matchNormalized(nt, p));
  if (!optIn) return { mode: 'lab' };
  // Catalog declaration order, first keyword match wins (specific before generic).
  for (const entry of ot.catalog) {
    if (entry.keywords.some((k) => matchNormalized(nt, k))) return { mode: 'official', entry };
  }
  return { mode: 'ambiguous' };
}

function slugify(name) {
  const s = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'zmp-app';
}

// Scaffold from an official template: codeload tarball (never `zmp init` — interactive,
// hangs non-tty; never git clone), extract via system tar, strip the top-level dir, copy
// into app/. Rebrand only what already exists: package.json/zmp-cli.json `name` and the
// existing title field of app-config.json. No __APP_NAME__ token, no variants — those are
// lab-template mechanisms. .env is never copied; APP_ID binding happens in the caller,
// identical to the lab path.
async function scaffoldOfficial(entry, appName, config, workspace, ctx) {
  const url = config.officialTemplates.tarballUrlPattern
    .replace('{repo}', entry.id)
    .replace('{branch}', entry.branch);
  const tmpDir = fs.mkdtempSync(path.join(workspace.root, '.official-tpl-'));
  try {
    ctx.event('bootstrap', { stage: 'scaffold', status: 'ok', detail: `fetching official template ${entry.id}`, url });
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tarFile = path.join(tmpDir, 'template.tar.gz');
    fs.writeFileSync(tarFile, Buffer.from(await res.arrayBuffer()));
    const extractDir = path.join(tmpDir, 'x');
    fs.mkdirSync(extractDir);
    const tar = spawnSync('tar', ['-xzf', tarFile, '-C', extractDir]);
    if (tar.status !== 0) {
      throw new Error(`tar extract failed: ${(tar.stderr || '').toString().slice(0, 200)}`);
    }
    const names = fs.readdirSync(extractDir).filter((n) => !n.startsWith('.'));
    const top = names.length === 1 ? path.join(extractDir, names[0]) : extractDir;
    fs.mkdirSync(workspace.appDir, { recursive: true });
    fs.cpSync(top, workspace.appDir, {
      recursive: true,
      force: true,
      filter: (src) => path.basename(src) !== '.env',
    });

    const slug = slugify(appName);
    for (const relFile of ['package.json', 'zmp-cli.json']) {
      const file = path.join(workspace.appDir, relFile);
      if (fs.existsSync(file)) {
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
        obj.name = slug;
        fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
      }
    }
    const appCfgFile = path.join(workspace.appDir, 'app-config.json');
    if (fs.existsSync(appCfgFile)) {
      const cfg = JSON.parse(fs.readFileSync(appCfgFile, 'utf8'));
      if (cfg.app && typeof cfg.app.title === 'string') cfg.app.title = appName;
      else if (typeof cfg.title === 'string') cfg.title = appName;
      fs.writeFileSync(appCfgFile, JSON.stringify(cfg, null, 2) + '\n');
    }
    ctx.event('bootstrap', {
      stage: 'scaffold',
      status: 'ok',
      detail: `official template ${entry.id} scaffolded (name=${slug}, title=${appName})`,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Finding recording ---------------------------------------------------------------
// Contract: Subagent C's record-finding.mjs exports recordFinding({workspace, runId, runDir,
// stage, category, severity, expected, actual, evidence}) -> finding (with findingId).
// Until it lands, a schema-valid fallback appends/merges into feedback/findings.jsonl
// directly so bootstrap never crashes.
async function recordFindingSafe(args) {
  try {
    const mod = await import('./record-finding.mjs');
    if (typeof mod.recordFinding === 'function') return await mod.recordFinding(args);
  } catch {
    // fall through to the fallback writer
  }
  const now = new Date().toISOString();
  const fp = fingerprint(args.stage, args.category, args.expected, args.actualClass || args.actual);
  const record = {
    schemaVersion: '1.0',
    findingId: `finding_${fp.slice(0, 12)}`,
    fingerprint: fp,
    runId: args.runId,
    stage: args.stage,
    category: args.category,
    severity: args.severity,
    expected: redactText(args.expected),
    actual: redactText(args.actual),
    evidence: args.evidence || [],
    status: 'open',
    firstSeenAt: now,
    lastSeenAt: now,
    occurrences: 1,
  };
  const file = path.join(args.workspace.feedbackDir, 'findings.jsonl');
  fs.mkdirSync(args.workspace.feedbackDir, { recursive: true });
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const idx = existing.findIndex((f) => f.fingerprint === fp);
  if (idx >= 0) {
    existing[idx].lastSeenAt = now;
    existing[idx].occurrences = (existing[idx].occurrences || 1) + 1;
    fs.writeFileSync(file, existing.map((f) => JSON.stringify(f)).join('\n') + '\n');
    return existing[idx];
  }
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

// --- Scaffold ------------------------------------------------------------------------
function scaffoldFromTemplate(appDir, appName, variant, config, ctx) {
  const variantSourceDir = config.template.variantSourceDir; // "variants"
  const templateExists =
    fs.existsSync(TEMPLATE_DIR) && fs.readdirSync(TEMPLATE_DIR).length > 0;

  fs.mkdirSync(appDir, { recursive: true });

  if (!templateExists) {
    ctx.event('bootstrap', {
      stage: 'scaffold',
      status: 'skipped',
      detail: 'template dir missing or empty; copied nothing (env binding still runs)',
    });
    return;
  }

  // Copy everything except the variants/ source dir. Never copy a template .env:
  // the workspace app/.env is only ever key-level-updated, never overwritten wholesale.
  fs.cpSync(TEMPLATE_DIR, appDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(TEMPLATE_DIR, src);
      if (rel === '') return true;
      const parts = rel.split(path.sep);
      if (parts[0] === variantSourceDir) return false;
      if (path.basename(src) === '.env') return false;
      return true;
    },
  });

  // Single template token: __APP_NAME__ (template contract — app-config.json, index.html).
  const token = config.template.tokens[0]; // "__APP_NAME__"
  for (const relFile of ['app-config.json', 'index.html']) {
    const file = path.join(appDir, relFile);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(token)) fs.writeFileSync(file, text.replaceAll(token, appName));
    }
  }

  // Variant data: variants/<variant>/catalog.ts -> src/data/catalog.ts.
  const variantSrc = path.join(TEMPLATE_DIR, variantSourceDir, variant, 'catalog.ts');
  const variantTarget = path.join(appDir, config.template.variantTargetFile);
  if (fs.existsSync(variantSrc)) {
    fs.mkdirSync(path.dirname(variantTarget), { recursive: true });
    fs.copyFileSync(variantSrc, variantTarget);
    ctx.event('bootstrap', { stage: 'scaffold', status: 'ok', detail: `variant ${variant} applied` });
  } else {
    ctx.event('bootstrap', {
      stage: 'scaffold',
      status: 'skipped',
      detail: `variant source ${variant}/catalog.ts not found in template; kept template default`,
    });
  }
}

// --- Main ----------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  let config;
  try {
    config = loadLabConfig();
  } catch (e) {
    die(`cannot load lab.config.json: ${e.message}`);
  }
  const workspace = resolveWorkspace(argv);

  const brief = getArg(argv, 'brief', null);
  const appName = getArg(argv, 'app-name', null) || config.defaults.appName;
  const invokedVia = getArg(argv, 'invoked-via', null) || 'harness';
  if (!INVOKED_VIA.includes(invokedVia)) {
    die(`invalid --invoked-via "${invokedVia}" (allowed: ${INVOKED_VIA.join(', ')})`);
  }

  const startedAt = new Date().toISOString();
  const provider = config.defaults.renderProvider;

  // Phase 2.5: resolve template selection first (pure parse of argv/brief vs the locked
  // catalog). Explicit invalid id die()s above (exit 3, ids listed). Opt-in without a
  // keyword match -> ask the user to choose; no scaffold, no guessing.
  const templateSel = resolveTemplateSelection(argv, brief, config);
  if (templateSel.mode === 'ambiguous') {
    const ids = config.officialTemplates.catalog.map((c) => c.id);
    const ambRunId = newRunId();
    const ambCtx = openRun(workspace.runsDir, ambRunId);
    ambCtx.event('bootstrap', {
      stage: 'input',
      status: 'fail',
      detail: 'official-template opt-in without a keyword match; user must choose a template id from the catalog',
    });
    process.stdout.write(
      JSON.stringify({
        runId: ambRunId,
        status: 'needs_template_choice',
        question:
          'Brief yêu cầu dùng mẫu có sẵn nhưng không khớp mẫu nào trong catalog. ' +
          'Chọn một template id rồi chạy lại bootstrap với --template official:<id>.',
        catalog: ids,
      }) + '\n'
    );
    process.exit(3);
  }

  // §5.2 step 1: prompt value (explicit flag, else embedded in the brief text).
  const promptAppId = normalizeAppId(getArg(argv, 'app-id', null)) ?? extractAppIdFromBrief(brief);
  // §5.2 step 2: APP_ID from canonical <workspace>/app/.env, if the file exists.
  const envFile = path.join(workspace.appDir, '.env');
  const projectAppId = fs.existsSync(envFile)
    ? parseEnvValue(fs.readFileSync(envFile, 'utf8'), 'APP_ID')
    : null;

  // Explicit user confirmation of the prompt ID after a conflict (finding_ae4ccee49c2e).
  // Only valid together with a matching prompt App ID; anything else is misuse.
  const confirmAppId = normalizeAppId(getArg(argv, 'confirm-app-id', null));
  if (confirmAppId !== null) {
    if (promptAppId === null) {
      die('--confirm-app-id requires a prompt App ID (--app-id or appId= embedded in --brief)');
    }
    if (confirmAppId !== promptAppId) {
      die(`--confirm-app-id (${confirmAppId}) does not match the prompt App ID (${promptAppId}); refusing`);
    }
  }

  const runId = newRunId();
  const runsDirForId = workspace.runsDir;

  // §5.2 step 4: both present and different -> stop BEFORE any mutation, ask the user.
  // Exception: a byte-exact --confirm-app-id is the user's explicit, authorized choice of the
  // prompt ID and allows the overwrite below (never silent — evented and read-back verified).
  if (promptAppId !== null && projectAppId !== null && promptAppId !== projectAppId && confirmAppId === null) {
    const ctx = openRun(runsDirForId, runId);
    ctx.event('bootstrap', {
      stage: 'input',
      status: 'needs_input',
      detail: 'app_id_conflict: prompt App ID differs from APP_ID in app/.env',
    });
    const finding = await recordFindingSafe({
      workspace,
      runId,
      runDir: ctx.runDir,
      stage: 'input',
      category: 'input',
      severity: 'blocking',
      expected: 'prompt App ID and APP_ID in app/.env agree (single source of truth)',
      actual: `app_id_conflict: prompt=${promptAppId} env=${projectAppId}; stopped before mutation`,
      actualClass: 'app_id_conflict',
      evidence: ['result.json'],
    });
    ctx.writeJson('result.json', {
      schemaVersion: '1.0',
      runId,
      status: 'needs_input',
      stage: 'input',
      provider,
      needsInput: {
        reason: 'app_id_conflict',
        question:
          `Prompt App ID (${promptAppId}) khác APP_ID hiện có trong app/.env (${projectAppId}). ` +
          'Chưa có gì bị sửa. Bạn muốn giữ ID nào? ' +
          `Giữ ID trong prompt (${promptAppId}) → chạy lại bootstrap với --app-id ${promptAppId} --confirm-app-id ${promptAppId}. ` +
          `Giữ ID hiện có của project (${projectAppId}) → chạy lại bootstrap không truyền App ID nào trong prompt/brief.`,
        promptAppId,
        projectAppId,
      },
      appIdSource: null,
      expectedAppId: null,
      resolvedAppId: null,
      appIdBound: false,
      gates: [],
      findingIds: [finding.findingId],
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    process.stdout.write(JSON.stringify({ runId, status: 'conflict' }) + '\n');
    process.exit(2);
  }

  // §5.2 step 5: neither prompt nor .env has an ID -> needs_input, nothing mutated.
  // Expected behavior, not an error: no finding is recorded.
  if (promptAppId === null && projectAppId === null) {
    const ctx = openRun(runsDirForId, runId);
    ctx.event('bootstrap', {
      stage: 'input',
      status: 'needs_input',
      detail: 'app_id_missing: no App ID in prompt and no app/.env APP_ID',
    });
    ctx.writeJson('result.json', {
      schemaVersion: '1.0',
      runId,
      status: 'needs_input',
      stage: 'input',
      provider,
      needsInput: {
        reason: 'app_id_missing',
        question:
          'Cần Mini App ID của app đã tạo trên Zalo Developers. Cung cấp ID (giữ nguyên dạng chuỗi, ' +
          'kể cả số 0 ở đầu) rồi chạy lại với --app-id. SKILL không tự tạo, không đoán và không lấy ID từ account.',
        promptAppId: null,
        projectAppId: null,
      },
      appIdSource: null,
      expectedAppId: null,
      resolvedAppId: null,
      appIdBound: false,
      gates: [],
      findingIds: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    process.stdout.write(JSON.stringify({ runId, status: 'needs_input' }) + '\n');
    process.exit(2);
  }

  // §5.2 steps 1–3: resolved. Prompt wins (also when both agree); else reuse project ID.
  const expectedAppId = promptAppId !== null ? promptAppId : projectAppId;
  const appIdSource = promptAppId !== null ? 'prompt' : 'existing_project';
  if (!/^\S+$/.test(expectedAppId)) {
    die(`resolved App ID contains whitespace after normalization; refusing to bind`);
  }

  const ctx = openRun(runsDirForId, runId);
  ctx.event('bootstrap', {
    stage: 'input',
    status: 'ok',
    detail: `appIdSource=${appIdSource} invokedVia=${invokedVia}`,
  });
  if (confirmAppId !== null && projectAppId !== null && projectAppId !== promptAppId) {
    ctx.event('bootstrap', {
      stage: 'input',
      status: 'ok',
      detail: 'app_id_conflict resolved by explicit user confirmation (--confirm-app-id); .env APP_ID will be overwritten',
    });
  }

  // Scaffold app/ (idempotent; never touches .env wholesale). Official path replaces the
  // lab-template mechanics entirely (no token, no variants); .env binding below is shared.
  const variant = classifyVariant(brief, config.template.variants);
  if (templateSel.mode === 'official') {
    try {
      await scaffoldOfficial(templateSel.entry, appName, config, workspace, ctx);
    } catch (e) {
      const finding = await recordFindingSafe({
        workspace,
        runId,
        runDir: ctx.runDir,
        stage: 'scaffold',
        category: 'environment',
        severity: 'blocking',
        expected: `official template tarball for ${templateSel.entry.id} fetchable and extractable`,
        actual: `official_template_unavailable: ${templateSel.entry.id} -> ${e.message}`,
        actualClass: 'official_template_unavailable',
        evidence: ['events.jsonl'],
      });
      ctx.event('bootstrap', {
        stage: 'scaffold',
        status: 'fail',
        detail: `official template scaffold failed: ${e.message}`,
        findingId: finding.findingId,
      });
      ctx.writeJson('result.json', {
        schemaVersion: '1.0',
        runId,
        status: 'fail',
        stage: 'scaffold',
        provider,
        appIdSource,
        expectedAppId,
        resolvedAppId: null,
        appIdBound: false,
        gates: [{ id: 'official_template_scaffold', status: 'fail', detail: 'tarball fetch/extract failed' }],
        findingIds: [finding.findingId],
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      process.stdout.write(JSON.stringify({ runId, status: 'fail' }) + '\n');
      process.exit(1);
    }
  } else {
    scaffoldFromTemplate(workspace.appDir, appName, variant, config, ctx);
  }
  ctx.event('bootstrap', {
    stage: 'scaffold',
    status: 'ok',
    detail:
      templateSel.mode === 'official'
        ? `template=official:${templateSel.entry.id} (variant ignored)`
        : `variant=${variant}`,
  });

  // Bind APP_ID: key-level upsert, then read back and exact-compare (binding invariant §5.2).
  upsertEnvKey(envFile, 'APP_ID', expectedAppId);
  const persistedAppId = parseEnvValue(fs.readFileSync(envFile, 'utf8'), 'APP_ID');
  const exactMatch = persistedAppId === expectedAppId;

  ctx.writeJson('evidence/app-id-binding.json', {
    sourcePath: 'app/.env',
    sourceType: appIdSource,
    expectedAppId,
    persistedAppId,
    exactMatch,
    // buildProcessAppId is appended later by build.mjs (loadEnv check).
  });

  if (!exactMatch) {
    const finding = await recordFindingSafe({
      workspace,
      runId,
      runDir: ctx.runDir,
      stage: 'scaffold',
      category: 'skill',
      severity: 'blocking',
      expected: 'APP_ID read back from app/.env exact-matches the resolved App ID',
      actual: `app_id_not_persisted: expected=${expectedAppId} persisted=${persistedAppId}`,
      actualClass: 'app_id_not_persisted',
      evidence: ['evidence/app-id-binding.json'],
    });
    ctx.event('bootstrap', {
      stage: 'scaffold',
      status: 'fail',
      detail: 'app_id_not_persisted',
      findingId: finding.findingId,
    });
    ctx.writeJson('result.json', {
      schemaVersion: '1.0',
      runId,
      status: 'fail',
      stage: 'scaffold',
      provider,
      appIdSource,
      expectedAppId,
      resolvedAppId: persistedAppId,
      appIdBound: false,
      gates: [{ id: 'app_id_bound', status: 'fail', detail: 'persisted APP_ID differs from resolved App ID' }],
      findingIds: [finding.findingId],
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    process.stdout.write(JSON.stringify({ runId, status: 'fail' }) + '\n');
    process.exit(1);
  }
  ctx.event('bootstrap', { stage: 'scaffold', status: 'ok', detail: 'APP_ID bound, read-back exact match' });

  // Normalized input for the rest of the pipeline (input.schema.json, additionalProperties:false).
  ctx.writeJson('input.json', {
    schemaVersion: '1.0',
    brief: brief ?? null,
    miniAppId: expectedAppId,
    appIdSource,
    appName,
    variant,
    template:
      templateSel.mode === 'official'
        ? { source: 'official', id: templateSel.entry.id }
        : { source: 'lab', id: 'lab-template' },
    renderProvider: provider,
    defaultViewport: config.defaults.defaultViewport,
    packageManager: config.defaults.packageManager,
    invokedVia,
  });

  ctx.event('bootstrap', { stage: 'scaffold', status: 'done' });
  process.stdout.write(JSON.stringify({ runId, status: 'ok' }) + '\n');
  process.exit(0);
}

main().catch((e) => die(e.stack || String(e)));
