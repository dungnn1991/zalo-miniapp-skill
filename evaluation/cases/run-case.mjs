#!/usr/bin/env node
// run-case.mjs — shared runner for the negative controls + golden case (Subagent C, plan §12).
//
//   node evaluation/cases/run-case.mjs <case-id>
//
// Creates a FRESH workspace under evaluation/cases/<case-id>/workspace/ (gitignored; deleted
// first), runs the scripted scenario against the skill scripts with --workspace, asserts the
// expectations from case.json, prints a PASS/FAIL JSON report.
//
// Exit codes: 0 case passed · 1 case failed · 2 blocked_dependency_missing (Subagent A/B files
// not merged yet — coded against the LOCKED contracts in README) · 3 usage/config error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASES_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.resolve(CASES_DIR, '..', '..');
const SKILL_SCRIPTS = path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'scripts');
const TEMPLATE_DIR = path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'assets', 'template');
const TEST_APP_ID = '1234567890';

// Dependencies each case needs from the parallel subagents (A: bootstrap/portal-fetch, B: template).
const CASE_DEPS = {
  'missing-dependency': ['bootstrap', 'template'],
  'react-no-mount': ['bootstrap', 'template'],
  'portal-404': ['bootstrap', 'portal-fetch', 'template'],
  'secret-redaction': [],
  'app-id-conflict': ['bootstrap', 'template'],
  'app-id-conflict-resolve': ['bootstrap', 'template'],
  'app-id-missing': ['bootstrap'],
  'css-overflow': ['bootstrap', 'template'],
  'golden': ['bootstrap', 'portal-fetch', 'template'],
  // Phase 2 controls run on cheap fixtures — no Subagent A/B dependency.
  // deploy-expired-token uses an isolated fake zmp binary: required CI stays deterministic
  // and never sends a garbage credential to the live API.
  'deploy-needs-login': [],
  'deploy-without-verify': [],
  'deploy-expired-token': [],
  'deploy-qr-parse': [],
  'login-not-scripted-gate': [],
  // Phase 2.5 — needs bootstrap's official-template path (Subagent A) + network to codeload.
  'official-template-golden': ['bootstrap'],
  'official-template-support': ['bootstrap'],
  // Phase 2.6 — preflight/insight/run-entry controls.
  'preflight-size-limit': ['bootstrap', 'template'],
  'preflight-server-side-api': ['bootstrap', 'template'],
  'preflight-asset-path': ['bootstrap', 'portal-fetch', 'template'],
  'cors-probe': [],
  'signature-match': [],
  'pageerror-object-detail': [],
  'run-entry': ['bootstrap', 'portal-fetch', 'template'],
  // Phase 3 — simulator (extra sim deps checked in-scenario: registry A, runner sim, template tab B).
  'sim-accept': ['bootstrap', 'portal-fetch', 'template'],
  'sim-deny': ['bootstrap', 'portal-fetch', 'template'],
  'sim-manual-sheet': ['bootstrap', 'portal-fetch', 'template'],
  'sim-unmocked': ['bootstrap', 'template'],
  'sim-runtime-marker': ['bootstrap', 'portal-fetch', 'template'],
  'lucky-wheel-phone-fail-closed': ['bootstrap'],
  'sim-permission-persist': ['bootstrap', 'template'],
  'doctor-autoinstall': [],
  // v0.3.1 — P0 regressions: safe rerun, workspace=cwd, installer host targeting.
  'preserve-user-code': ['bootstrap', 'template'],
  'workspace-default-cwd': ['bootstrap', 'template'],
  'installer-hosts': [],
  'version-reporting': [],
};

// Phase 3 sim dependencies from the parallel owners — code is written against the contract;
// report blocked instead of failing when one has not landed yet.
function simDepsMissing() {
  const missing = [];
  const skill = path.join(LAB_ROOT, 'skill', 'create-zmp-app');
  if (!fs.existsSync(path.join(skill, 'references', 'sim-mock-data.json'))) missing.push('references/sim-mock-data.json (Subagent A)');
  try {
    if (!fs.readFileSync(path.join(skill, 'scripts', 'browser', 'runner.mjs'), 'utf8').includes('sim-manifest')) {
      missing.push('runner simulator support (lead)');
    }
  } catch { missing.push('scripts/browser/runner.mjs (lead)'); }
  const tplSrc = path.join(skill, 'assets', 'template', 'src');
  let hasTab = false;
  const stack = [tplSrc];
  while (stack.length && !hasTab) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) break;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && /\.(tsx?|jsx?)$/.test(e.name) && fs.readFileSync(full, 'utf8').includes('nav-account')) { hasTab = true; break; }
    }
  }
  if (!hasTab) missing.push('template demo tab nav-account (Subagent B)');
  return missing;
}

const SIM_CASE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Zalo android/24000000';

function readBridgeLog(ws, runId) {
  const file = path.join(ws, 'runs', runId, 'evidence', 'bridge-log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// bootstrap → portal-fetch → install → build, shared by the sim cases.
function simBuildPipeline(ws, check) {
  const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
  check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}: ${boot.stderr.slice(-200)}`);
  const runId = boot.lastJson?.runId;
  if (!runId) return null;
  for (const step of ['portal-fetch', 'install', 'build']) {
    const r = runScript(ws, step, ['--run-id', runId]);
    check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
    if (r.code !== 0) return null;
  }
  return runId;
}

function missingDeps(deps) {
  const missing = [];
  for (const d of deps) {
    if (d === 'template') {
      if (!fs.existsSync(path.join(TEMPLATE_DIR, 'package.json'))) missing.push('assets/template/ (Subagent B)');
    } else if (!fs.existsSync(path.join(SKILL_SCRIPTS, `${d}.mjs`))) {
      missing.push(`scripts/${d}.mjs (Subagent A)`);
    }
  }
  return missing;
}

function runScript(ws, name, args = [], env = {}, timeoutMs = 0) {
  const res = spawnSync(process.execPath, [path.join(SKILL_SCRIPTS, `${name}.mjs`), '--workspace', ws, ...args], {
    cwd: LAB_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...env },
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  const stdout = res.stdout || '';
  let lastJson = null;
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && !lastJson; i--) {
    try { lastJson = JSON.parse(lines[i]); } catch { /* not json */ }
  }
  return { code: res.status ?? -1, stdout, stderr: res.stderr || '', lastJson };
}

function readFindings(ws) {
  const file = path.join(ws, 'feedback', 'findings.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function hasFinding(findings, { category = null, textHint = null, stages = null }) {
  return findings.some((f) => {
    if (category && !category.split('|').includes(f.category)) return false;
    if (stages && !stages.includes(f.stage)) return false;
    if (textHint && !JSON.stringify(f).toLowerCase().includes(textHint.toLowerCase())) return false;
    return true;
  });
}

// --- Phase 2 fixture helpers ------------------------------------------------

function libRunContext() {
  return import(pathToFileURL(path.join(SKILL_SCRIPTS, 'lib', 'run-context.mjs')).href);
}

// Cheap deploy fixture: fake dist + app-config + .env; a fresh run dir. This tests the
// deploy.mjs contract, not the build pipeline.
async function makeDeployFixture(ws, envLines) {
  const { openRun, newRunId } = await libRunContext();
  const appDir = path.join(ws, 'app');
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"deploy-fixture","private":true}\n');
  // A real script asset so `zmp sync-config dist/index.html` has something to declare.
  fs.writeFileSync(path.join(appDir, 'dist', 'index.html'),
    '<!doctype html><title>deploy fixture</title><script src="./app.js"></script>\n');
  fs.writeFileSync(path.join(appDir, 'dist', 'app.js'), 'console.log("deploy fixture");\n');
  const tplCfg = path.join(TEMPLATE_DIR, 'app-config.json');
  fs.writeFileSync(path.join(appDir, 'app-config.json'), fs.existsSync(tplCfg)
    ? fs.readFileSync(tplCfg, 'utf8').replaceAll('__APP_NAME__', 'deploy fixture')
    : '{"app":{"title":"deploy fixture"}}\n');
  fs.writeFileSync(path.join(appDir, '.env'), envLines.join('\n') + '\n');
  const runId = newRunId();
  const ctx = openRun(path.join(ws, 'runs'), runId);
  return { runId, ctx, appDir };
}

function writePassResult(ctx, runId) {
  const now = new Date().toISOString();
  ctx.writeJson('result.json', {
    schemaVersion: '1.0', runId, status: 'pass', stage: 'done', provider: 'browser',
    appIdSource: 'prompt', expectedAppId: '1234567890', resolvedAppId: '1234567890', appIdBound: true,
    gates: [{ id: 'fixture_gate', status: 'pass' }], findingIds: [], startedAt: now, finishedAt: now,
  });
}

function readRunEvents(ws, runId) {
  const file = path.join(ws, 'runs', runId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// All non-.png files under runs/<id>/ as [relPath, content].
function readRunTextFiles(ws, runId) {
  const runDir = path.join(ws, 'runs', runId);
  const out = [];
  const stack = [runDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && !entry.name.endsWith('.png')) out.push([path.relative(runDir, full), fs.readFileSync(full, 'utf8')]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenarios. Each pushes {name, ok, detail} checks; case passes iff all ok.
// A scenario may return "blocked: <reason>" to report blocked instead of pass/fail.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  'missing-dependency'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}: ${boot.stderr.slice(-300)}`);
    const runId = boot.lastJson?.runId;
    check('bootstrap prints runId', !!runId, boot.stdout.slice(-200));
    if (!runId) return;

    const pkgFile = path.join(ws, 'app', 'package.json');
    const pkg = readJsonIfExists(pkgFile);
    check('app/package.json scaffolded', !!pkg, pkgFile);
    if (!pkg) return;
    const victim = pkg.dependencies?.['zmp-ui'] ? 'zmp-ui' : 'react';
    if (victim === 'react') note('friction: template has no zmp-ui dependency — corrupted react instead');
    delete pkg.dependencies[victim];
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    note(`removed dependency '${victim}' from app/package.json`);

    const inst = runScript(ws, 'install', ['--run-id', runId]);
    let failedStage = null;
    if (inst.code !== 0) {
      failedStage = 'install';
      check('install exits 1 on corrupted manifest', inst.code === 1, `exit ${inst.code}`);
    } else {
      const build = runScript(ws, 'build', ['--run-id', runId]);
      failedStage = 'build';
      check('build exits 1 without the dependency', build.code === 1, `exit ${build.code}: ${build.stderr.slice(-300)}`);
    }
    check('finding category dependency recorded',
      hasFinding(readFindings(ws), { category: 'dependency', stages: ['install', 'build'] }),
      `stage=${failedStage}, findings=${JSON.stringify(readFindings(ws).map((f) => [f.stage, f.category]))}`);
  },

  'react-no-mount'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}: ${boot.stderr.slice(-300)}`);
    const runId = boot.lastJson?.runId;
    if (!runId) { check('bootstrap prints runId', false, boot.stdout.slice(-200)); return; }

    const entry = ['src/main.tsx', 'src/index.tsx'].map((p) => path.join(ws, 'app', p)).find((p) => fs.existsSync(p));
    if (!entry) { check('mount entry found (src/main.tsx)', false, 'friction: template entry file not found — cannot inject mount break'); return; }
    const src = fs.readFileSync(entry, 'utf8');
    const broken = src.replace(/getElementById\(\s*(['"])[^'"]+\1\s*\)/, "getElementById('zz-nonexistent-root')");
    if (broken === src) { check('mount target injectable', false, `friction: no getElementById('<id>') pattern in ${entry}`); return; }
    fs.writeFileSync(entry, broken);
    note(`broke mount target in ${path.relative(ws, entry)}`);

    check('install exits 0', runScript(ws, 'install', ['--run-id', runId]).code === 0, '');
    check('build exits 0', runScript(ws, 'build', ['--run-id', runId]).code === 0, '');
    const render = runScript(ws, 'render', ['--run-id', runId]);
    check('render exits 1', render.code === 1, `exit ${render.code}: ${render.stderr.slice(-300)}`);
    const gates = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'));
    check('react_mount gate failed', !!gates?.gates?.some((g) => g.id === 'react_mount' && g.status === 'fail'),
      JSON.stringify(gates?.gates?.filter((g) => g.id === 'react_mount') ?? 'no gates.json'));
    const verify = runScript(ws, 'verify', ['--run-id', runId]);
    check('verify exits 1', verify.code === 1, `exit ${verify.code}`);
    check('finding category template|app recorded', hasFinding(readFindings(ws), { category: 'template|app' }),
      JSON.stringify(readFindings(ws).map((f) => [f.category, f.expected])));
  },

  'portal-404'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) { check('bootstrap prints runId', false, boot.stdout.slice(-200)); return; }

    const fetch = runScript(ws, 'portal-fetch', ['--run-id', runId],
      { MB_PORTAL_BASE_URL: 'https://docs.zaloplatforms.com/definitely-not-here-9x7' });
    if (fetch.code === 0) {
      note('friction: portal-fetch exited 0 despite MB_PORTAL_BASE_URL pointing nowhere — test-only override likely not implemented by Subagent A');
    }
    check('portal-fetch exits 1', fetch.code === 1, `exit ${fetch.code}: ${fetch.stderr.slice(-300)}`);
    check('finding portal_unavailable recorded',
      hasFinding(readFindings(ws), { textHint: 'portal_unavailable' }) || hasFinding(readFindings(ws), { textHint: 'portal' }),
      JSON.stringify(readFindings(ws).map((f) => [f.category, f.expected])));
    const sources = readJsonIfExists(path.join(ws, 'runs', runId, 'portal-sources.json'));
    const list = Array.isArray(sources) ? sources : sources?.sources;
    const claimsSuccess = Array.isArray(list)
      && list.length > 0
      && list.every((s) => s?.status === 200 || s?.status === '200' || s?.status === 'ok' || s?.status === 'fetched');
    check('no portal-sources.json claiming success', !claimsSuccess, JSON.stringify(sources)?.slice(0, 300) ?? 'absent (ok)');
  },

  async 'secret-redaction'({ ws, check, note }) {
    // Pure locked-lib test — no app, no Subagent A/B code.
    const { openRun, newRunId } = await import(
      pathToFileURL(path.join(SKILL_SCRIPTS, 'lib', 'run-context.mjs')).href
    );
    const fake = ['gh', 'p_'].join('') + crypto.randomBytes(12).toString('hex'); // secret-shaped, built at runtime
    const runId = newRunId();
    const ctx = openRun(path.join(ws, 'runs'), runId);
    ctx.writeTextEvidence('evidence/redaction-probe.log', `probe token=${fake} end`);
    ctx.event('redaction_probe', { stage: 'verify', message: `leaked ${fake} in event` });
    note(`probe run ${runId}`);

    const log = fs.readFileSync(path.join(ws, 'runs', runId, 'evidence', 'redaction-probe.log'), 'utf8');
    const events = fs.readFileSync(path.join(ws, 'runs', runId, 'events.jsonl'), 'utf8');
    check('evidence file contains [REDACTED]', log.includes('[REDACTED]'), log.slice(0, 200));
    check('evidence file does not contain raw token', !log.includes(fake), '');
    check('events.jsonl contains [REDACTED]', events.includes('[REDACTED]'), events.slice(0, 200));
    check('events.jsonl does not contain raw token', !events.includes(fake), '');
  },

  'app-id-conflict'({ ws, check }) {
    const boot1 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '1111111111']);
    check('first bootstrap (id A) exits 0', boot1.code === 0, `exit ${boot1.code}: ${boot1.stderr.slice(-300)}`);
    const envFile = path.join(ws, 'app', '.env');
    const envBefore = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
    check('app/.env written with id A', !!envBefore && envBefore.includes('1111111111'), String(envBefore).slice(0, 100));

    const boot2 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '2222222222']);
    check('second bootstrap (id B) exits 2', boot2.code === 2, `exit ${boot2.code}: ${boot2.stderr.slice(-300)}`);
    check('stdout status is conflict', boot2.lastJson?.status === 'conflict', JSON.stringify(boot2.lastJson));
    const envAfter = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
    check('.env unchanged — still exactly id A', envAfter === envBefore && !!envAfter && !envAfter.includes('2222222222'),
      String(envAfter).slice(0, 100));
    check('finding category input with app_id_conflict semantics',
      hasFinding(readFindings(ws), { category: 'input', textHint: 'conflict' }),
      JSON.stringify(readFindings(ws).map((f) => [f.category, f.expected])));
    const runId2 = boot2.lastJson?.runId;
    if (runId2) {
      const result = readJsonIfExists(path.join(ws, 'runs', runId2, 'result.json'));
      if (result) {
        check('result.json status needs_input (reason app_id_conflict)',
          result.status === 'needs_input' && (result.needsInput?.reason ?? 'app_id_conflict') === 'app_id_conflict',
          JSON.stringify({ status: result.status, needsInput: result.needsInput }));
      }
    }
  },

  // Regression for finding_ae4ccee49c2e: --confirm-app-id <id> byte-equal to the prompt App ID
  // authorizes overwriting a conflicting app/.env APP_ID; all other branches stay unchanged.
  'app-id-conflict-resolve'({ ws, check, note }) {
    const envFile = path.join(ws, 'app', '.env');
    const readEnv = () => (fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null);
    const envAppId = (txt) => txt?.match(/^APP_ID=(.*)$/m)?.[1]?.trim() ?? null;

    // 1. scaffold + bind 1111
    const boot1 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '1111']);
    check('step1: bootstrap --app-id 1111 exits 0', boot1.code === 0, `exit ${boot1.code}: ${boot1.stderr.slice(-300)}`);
    check('step1: .env binds APP_ID=1111', envAppId(readEnv()) === '1111', String(readEnv()).slice(0, 100));

    // 2. guard — conflict detection unchanged without the flag
    const boot2 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '2222']);
    check('step2: conflicting bootstrap exits 2', boot2.code === 2, `exit ${boot2.code}: ${boot2.stderr.slice(-300)}`);
    check('step2: stdout status is conflict', boot2.lastJson?.status === 'conflict', JSON.stringify(boot2.lastJson));
    check('step2: .env still exactly 1111', envAppId(readEnv()) === '1111' && !String(readEnv()).includes('2222'),
      String(readEnv()).slice(0, 100));

    // 3. fix path — byte-equal confirm authorizes the overwrite
    const boot3 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '2222', '--confirm-app-id', '2222']);
    if (boot3.code !== 0) {
      note('step3 failed — if --confirm-app-id is not implemented yet (Subagent A mid-fix), re-run this case after the fix lands');
    }
    check('step3: confirmed bootstrap exits 0', boot3.code === 0, `exit ${boot3.code}: ${(boot3.stderr || boot3.stdout).slice(-300)}`);
    check('step3: .env becomes exactly APP_ID=2222', envAppId(readEnv()) === '2222' && !String(readEnv()).includes('1111'),
      String(readEnv()).slice(0, 100));
    const runId3 = boot3.lastJson?.runId;
    if (runId3) {
      const input3 = readJsonIfExists(path.join(ws, 'runs', runId3, 'input.json'));
      check('step3: input.json appIdSource is prompt', input3?.appIdSource === 'prompt', JSON.stringify(input3)?.slice(0, 200));
      const binding3 = readJsonIfExists(path.join(ws, 'runs', runId3, 'evidence', 'app-id-binding.json'));
      check('step3: app-id-binding.json exactMatch true',
        binding3?.exactMatch === true && binding3?.expectedAppId === '2222', JSON.stringify(binding3)?.slice(0, 200));
    } else {
      check('step3: bootstrap prints runId', false, boot3.stdout.slice(-200));
    }

    // 4. negative guard — confirm that mismatches the prompt id must refuse, no mutation
    const envBefore4 = readEnv();
    const boot4 = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', '3333', '--confirm-app-id', '9999']);
    check('step4: mismatching --confirm-app-id exits 3', boot4.code === 3, `exit ${boot4.code}: ${(boot4.stderr || boot4.stdout).slice(-300)}`);
    check('step4: .env untouched (still 2222)',
      readEnv() === envBefore4 && envAppId(readEnv()) === '2222'
        && !String(readEnv()).includes('3333') && !String(readEnv()).includes('9999'),
      String(readEnv()).slice(0, 100));
  },

  'app-id-missing'({ ws, check }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo']);
    check('bootstrap exits 2', boot.code === 2, `exit ${boot.code}: ${boot.stderr.slice(-300)}`);
    check('stdout status is needs_input', boot.lastJson?.status === 'needs_input', JSON.stringify(boot.lastJson));
    check('no app/ scaffold', !fs.existsSync(path.join(ws, 'app')), '');
    const runId = boot.lastJson?.runId;
    check('bootstrap prints runId', !!runId, boot.stdout.slice(-200));
    if (!runId) return;
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json status needs_input', result?.status === 'needs_input', JSON.stringify(result)?.slice(0, 300));
    if (result?.needsInput) {
      check('needsInput.reason is app_id_missing', result.needsInput.reason === 'app_id_missing', JSON.stringify(result.needsInput));
    }
    check('no invented id in result.json',
      (result?.expectedAppId ?? null) === null && (result?.resolvedAppId ?? null) === null,
      `expectedAppId=${result?.expectedAppId} resolvedAppId=${result?.resolvedAppId}`);
    const input = readJsonIfExists(path.join(ws, 'runs', runId, 'input.json'));
    check('no invented miniAppId in input.json', !input || !input.miniAppId, JSON.stringify(input)?.slice(0, 200));
  },

  'css-overflow'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) { check('bootstrap prints runId', false, boot.stdout.slice(-200)); return; }
    check('install exits 0', runScript(ws, 'install', ['--run-id', runId]).code === 0, '');
    check('build exits 0', runScript(ws, 'build', ['--run-id', runId]).code === 0, '');

    // Fixture: mutate the BUILT dist inside the case workspace (allowed for negative controls).
    const indexFile = path.join(ws, 'app', 'dist', 'index.html');
    const html = fs.readFileSync(indexFile, 'utf8');
    const style = '<style>body{min-width:1600px}</style>';
    fs.writeFileSync(indexFile, html.includes('</body>') ? html.replace('</body>', `${style}</body>`) : html + style);
    note('injected forced-overflow stylesheet into dist/index.html');

    const render = runScript(ws, 'render', ['--run-id', runId]);
    check('render exits 1', render.code === 1, `exit ${render.code}: ${render.stderr.slice(-300)}`);
    const gates = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'));
    check('no_horizontal_overflow gate failed',
      !!gates?.gates?.some((g) => g.id === 'no_horizontal_overflow' && g.status === 'fail'),
      JSON.stringify(gates?.gates?.filter((g) => g.id === 'no_horizontal_overflow') ?? 'no gates.json'));
    check('verify exits 1', runScript(ws, 'verify', ['--run-id', runId]).code === 1, '');
    check("finding expected mentions 'no horizontal overflow'",
      readFindings(ws).some((f) => f.expected.toLowerCase().includes('no horizontal overflow')),
      JSON.stringify(readFindings(ws).map((f) => f.expected)));
  },

  async 'deploy-needs-login'({ ws, check }) {
    const { runId, ctx, appDir } = await makeDeployFixture(ws, ['APP_ID=1234567890']);
    writePassResult(ctx, runId);

    const dep = runScript(ws, 'deploy', ['--run-id', runId]);
    check('deploy exits 2', dep.code === 2, `exit ${dep.code}: ${(dep.stderr || dep.stdout).slice(-300)}`);
    check('deploy stdout reason login_required', dep.lastJson?.reason === 'login_required', JSON.stringify(dep.lastJson));
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json needs_input/login_required, schemaVersion 1.1',
      result?.status === 'needs_input' && result?.needsInput?.reason === 'login_required' && result?.schemaVersion === '1.1',
      JSON.stringify({ schemaVersion: result?.schemaVersion, status: result?.status, needsInput: result?.needsInput?.reason }));
    check('no deploy spawn event (no zmp process ran)',
      !readRunEvents(ws, runId).some((e) => e.step === 'deploy' && e.status === 'start'),
      JSON.stringify(readRunEvents(ws, runId).filter((e) => e.step === 'deploy')));
    check('no sync-config spawn either (token check comes first)',
      !readRunEvents(ws, runId).some((e) => e.step === 'sync-config')
        && !fs.existsSync(path.join(ws, 'runs', runId, 'evidence', 'sync-config.log')),
      JSON.stringify(readRunEvents(ws, runId).filter((e) => e.step === 'sync-config')));
    check('no deploy.log written', !fs.existsSync(path.join(ws, 'runs', runId, 'evidence', 'deploy.log')), '');

    // ensure-login round-trip on the same fixture.
    const el1 = runScript(ws, 'ensure-login', ['--run-id', runId]);
    check('ensure-login exits 2 without ZMP_TOKEN key', el1.code === 2, `exit ${el1.code}`);
    // Key-existence only: an empty-value key line is enough — no fake token value anywhere.
    fs.appendFileSync(path.join(appDir, '.env'), 'ZMP_TOKEN=\n');
    const el2 = runScript(ws, 'ensure-login', ['--run-id', runId]);
    check('ensure-login exits 0 once key exists', el2.code === 0, `exit ${el2.code}: ${(el2.stderr || el2.stdout).slice(-300)}`);
    const reverted = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result reverted to pass after login (pipeline can continue to deploy)',
      reverted?.status === 'pass' && reverted?.needsInput === undefined,
      JSON.stringify({ status: reverted?.status, needsInput: reverted?.needsInput }));
  },

  async 'deploy-without-verify'({ ws, check }) {
    const { runId } = await makeDeployFixture(ws, ['APP_ID=1234567890']); // no result.json written
    const dep = runScript(ws, 'deploy', ['--run-id', runId]);
    check('deploy exits 1', dep.code === 1, `exit ${dep.code}: ${(dep.stderr || dep.stdout).slice(-300)}`);
    check('finding stage deploy, category harness recorded',
      hasFinding(readFindings(ws), { category: 'harness', stages: ['deploy'] }),
      JSON.stringify(readFindings(ws).map((f) => [f.stage, f.category, f.expected])));
    check('no deploy/sync-config spawn event (no zmp process ran)',
      !readRunEvents(ws, runId).some((e) => (e.step === 'deploy' && e.status === 'start') || e.step === 'sync-config'), '');
    check('no deploy.log written', !fs.existsSync(path.join(ws, 'runs', runId, 'evidence', 'deploy.log')), '');
  },

  async 'deploy-expired-token'({ ws, check, note }) {
    // JWT-shaped garbage built at runtime — never a real credential, never committed.
    const b64u = (n) => crypto.randomBytes(n).toString('base64url');
    const fakeToken = `eyJ${b64u(24)}.${b64u(32)}.${b64u(24)}`;
    const { runId, ctx } = await makeDeployFixture(ws, ['APP_ID=1234567890', `ZMP_TOKEN=${fakeToken}`]);
    writePassResult(ctx, runId);

    // Deterministic CLI double: sync-config succeeds; deploy echoes the fake token on purpose
    // (redaction regression) then returns the pinned auth-failure message. No live network.
    const fakeBin = path.join(ws, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeZmp = path.join(fakeBin, 'zmp');
    fs.writeFileSync(fakeZmp, `#!/usr/bin/env node
import fs from 'node:fs';
const cmd = process.argv[2];
if (cmd === '--version') { console.log('4.0.3'); process.exit(0); }
if (cmd === 'sync-config') { console.log('Sync config done'); process.exit(0); }
if (cmd === 'deploy') {
  const env = fs.readFileSync('.env', 'utf8');
  const token = /^ZMP_TOKEN=(.*)$/m.exec(env)?.[1] ?? '';
  console.error('debug token=' + token);
  console.error('Permission denied. Please login again.');
  process.exit(1);
}
console.error('unexpected fake-zmp command: ' + cmd);
process.exit(9);
`);
    fs.chmodSync(fakeZmp, 0o755);
    const dep = runScript(ws, 'deploy', ['--run-id', runId], {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    }, 30000);
    const logFile = path.join(ws, 'runs', runId, 'evidence', 'deploy.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

    check('deploy exits 2 (fake CLI rejects garbage token, back to login gate)', dep.code === 2,
      `exit ${dep.code}: ${(dep.stderr || dep.stdout).slice(-300)}\nlog tail: ${log.slice(-300)}`);
    const events = readRunEvents(ws, runId);
    check('sync-config ran ok BEFORE the deploy attempt (finding_1d573da3fa61 order)',
      events.some((e) => e.step === 'sync-config' && e.exitCode === 0)
        && events.findIndex((e) => e.step === 'sync-config') < events.findIndex((e) => e.step === 'deploy' && e.status === 'start'),
      JSON.stringify(events.filter((e) => e.step === 'sync-config').map((e) => [e.status, e.exitCode])));
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json needs_input/login_required',
      result?.status === 'needs_input' && result?.needsInput?.reason === 'login_required',
      JSON.stringify({ status: result?.status, reason: result?.needsInput?.reason }));
    check('deploy.log exists (evidence kept)', log.length > 0, logFile);

    // Token custody on the real deploy path: the raw value must not exist anywhere under runs/.
    const leaks = readRunTextFiles(ws, runId).filter(([, content]) => content.includes(fakeToken)).map(([rel]) => rel);
    check('raw fake token absent from every run artifact', leaks.length === 0, `leaked into: ${leaks.join(', ')}`);
    const redactionVisible = log.includes('[REDACTED]');
    const tokenShapedEcho = /eyJ[A-Za-z0-9_-]+\./.test(log);
    check('deploy.log redaction holds ([REDACTED] marker, or CLI never echoed token-shaped content)',
      redactionVisible || !tokenShapedEcho, 'token-shaped content in deploy.log without [REDACTED]');
    note(redactionVisible
      ? 'CLI echoed token-shaped content; redaction replaced it with [REDACTED]'
      : 'CLI did not echo token-shaped content; redaction not exercised on this output (raw-absence still proven)');
  },

  // Regression finding_42bccd1d5f27 — parse-only against the REAL deploy.log captured from
  // run f08e (CLI 4.0.3, QR-only output). Never spawns zmp.
  async 'deploy-qr-parse'({ check }) {
    try {
      const { createRequire } = await import('node:module');
      createRequire(path.join(LAB_ROOT, 'package.json'))('jsqr');
    } catch {
      return 'blocked: jsqr missing from lab root node_modules (lead-added devDependency)';
    }
    const mod = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'deploy.mjs')).href);
    const log = fs.readFileSync(path.join(CASES_DIR, 'deploy-qr-parse', 'fixture', 'deploy.log'), 'utf8');
    const expectedUrl = 'https://zalo.me/s/2607885157171557191/?env=DEVELOPMENT&version=zdev-dc3f8ce8';

    const qr = mod.decodeQrFromOutput(log);
    check('QR after "View app at:" decodes to the real deployed URL', qr === expectedUrl, String(qr));
    check('text URL parser finds nothing in QR-only output (CLI 4.0.3)',
      mod.parseDeployedUrl(log) === null, String(mod.parseDeployedUrl(log)));
    check('versionLabel = trailing Version line after Deploy Done',
      mod.parseVersionLabel(log) === 'zdev-dc3f8ce8', String(mod.parseVersionLabel(log)));
    check('banner "Version: 4.0.3" never mistaken for the label', mod.parseVersionLabel(log) !== '4.0.3', '');
    // Future-proofing: if a later CLI prints the URL as text, the text parser takes over.
    const textSample = 'View app at: //zalo.me/s/123/?env=TESTING&version=v2';
    check('text parser normalizes //zalo.me/s/... to https://',
      mod.parseDeployedUrl(textSample) === 'https://zalo.me/s/123/?env=TESTING&version=v2',
      String(mod.parseDeployedUrl(textSample)));
  },

  async 'login-not-scripted-gate'({ ws, check }) {
    const { openRun, newRunId } = await libRunContext();
    const runId = newRunId();
    const ctx = openRun(path.join(ws, 'runs'), runId);
    // Forbidden-command fixture (fake token arg, constructed here, never a real credential).
    ctx.event('login', { stage: 'login', command: 'zmp login --token fake-xyz-not-a-real-token' });
    check('fixture event recorded with command intact',
      readRunEvents(ws, runId).some((e) => typeof e.command === 'string' && e.command.includes('--token')), '');

    const ver = runScript(ws, 'verify', ['--run-id', runId]);
    check('verify exits 1', ver.code === 1, `exit ${ver.code}: ${(ver.stderr || ver.stdout).slice(-300)}`);
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json schemaVersion 1.1 (Phase 2 gates active)', result?.schemaVersion === '1.1', result?.schemaVersion);
    check('gate login_not_scripted failed',
      !!result?.gates?.some((g) => g.id === 'login_not_scripted' && g.status === 'fail'),
      JSON.stringify(result?.gates?.filter((g) => g.id === 'login_not_scripted')));
    check('finding stage login, category skill recorded',
      hasFinding(readFindings(ws), { category: 'skill', stages: ['login'] }),
      JSON.stringify(readFindings(ws).map((f) => [f.stage, f.category])));
  },

  // Phase 2.6 negative control: a >3MB file in vite's public/ lands in dist → size_limit FAIL.
  async 'preflight-size-limit'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    check('install exits 0', runScript(ws, 'install', ['--run-id', runId]).code === 0, '');
    fs.mkdirSync(path.join(ws, 'app', 'public'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'app', 'public', 'big-fixture.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
    note('planted 4MB file in app/public (vite copies public/ into the build output)');
    const build = runScript(ws, 'build', ['--run-id', runId]);
    check('build exits 1 on size_limit', build.code === 1, `exit ${build.code}: ${(build.stderr || build.stdout).slice(-300)}`);
    const pf = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'preflight.json'));
    check('preflight.json records size_limit fail',
      !!pf?.gates?.some((g) => g.id === 'size_limit' && g.status === 'fail'), JSON.stringify(pf)?.slice(0, 300));
    check('finding category app with size insight',
      readFindings(ws).some((f) => f.category === 'app' && f.stage === 'build'
        && /size/i.test(f.expected) && f.insight?.fix),
      JSON.stringify(readFindings(ws).map((f) => [f.category, f.expected.slice(0, 50), !!f.insight])));
  },

  // Phase 2.6 negative control: client code calling graph.zalo.me → hard FAIL before build.
  async 'preflight-server-side-api'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    fs.writeFileSync(path.join(ws, 'app', 'src', 'evil-api.ts'),
      'export const me = () => fetch("https://graph.zalo.me/v2.0/me");\n');
    note('injected src/evil-api.ts calling graph.zalo.me from the client');
    const build = runScript(ws, 'build', ['--run-id', runId]); // no install needed — scan fails first
    check('build exits 1 on server_side_api_scan (before vite runs)', build.code === 1,
      `exit ${build.code}: ${(build.stderr || build.stdout).slice(-300)}`);
    const finding = readFindings(ws).find((f) => f.expected.includes('server_side_api_scan'));
    check('blocking finding category app with FAQ 22 insight',
      finding?.category === 'app' && finding?.severity === 'blocking' && !!finding?.insight?.fix,
      JSON.stringify(finding)?.slice(0, 300));
    check('no vite build event (scan fired first)',
      !readRunEvents(ws, runId).some((e) => e.command === 'pnpm exec vite build'), '');
  },

  // Phase 2.6 negative control: absolute asset path → WARN only, full run still passes.
  async 'preflight-asset-path'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    fs.writeFileSync(path.join(ws, 'app', 'src', 'bad-asset.ts'),
      'export const banner = \'<img src="/logo.png" />\';\n');
    note('injected src/bad-asset.ts with an absolute asset path');
    for (const step of ['portal-fetch', 'install', 'build', 'render', 'verify']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
      if (r.code !== 0) return;
    }
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result pass with asset_path_scan gate = warn',
      result?.status === 'pass' && result?.gates?.some((g) => g.id === 'asset_path_scan' && g.status === 'warn'),
      JSON.stringify({ status: result?.status, gate: result?.gates?.find((g) => g.id === 'asset_path_scan') }));
    check('insights[] carries asset_path_scan (kind gate, FAQ 23)',
      !!result?.insights?.some((i) => i.id === 'asset_path_scan' && i.kind === 'gate' && i.fix),
      JSON.stringify(result?.insights));
  },

  // Phase 2.6 acceptance #2: CORS preflight probe against local mock servers (probing
  // 127.0.0.1 is explicitly allowed for this case).
  async 'cors-probe'({ check, note }) {
    const { createServer } = await import('node:http');
    const mkServer = (headers) => new Promise((resolve) => {
      const s = createServer((req, res) => { res.writeHead(204, headers); res.end(); });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const bad = await mkServer({});                                              // no ACAO at all
    const good = await mkServer({ 'Access-Control-Allow-Origin': '*' });         // permissive
    const wrong = await mkServer({ 'Access-Control-Allow-Origin': 'https://evil.example' });
    try {
      const insight = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'insight.mjs')).href);
      const badO = `http://127.0.0.1:${bad.address().port}`;
      const goodO = `http://127.0.0.1:${good.address().port}`;
      const wrongO = `http://127.0.0.1:${wrong.address().port}`;
      const srcTexts = [{
        rel: 'src/api.ts',
        text: `fetch("${badO}/api");\naxios.get("${goodO}/x");\nfetch("${wrongO}/y");\nfetch("https://api.zalo.me/skip");\nconst img = "https://images.example.com/no-fetch-here.png";\n`,
      }];
      const origins = insight.extractFetchOrigins(srcTexts);
      check('extract: 3 local origins, zalo-owned skipped, non-fetch URL skipped',
        origins.length === 3 && !origins.some((o) => o.includes('zalo.me') || o.includes('images.example.com')),
        JSON.stringify(origins));
      const passive = await insight.corsPreflightGate(srcTexts, { timeoutMs: 3000 });
      check('default stays passive and warns without network claims',
        passive.status === 'warn' && /passive scan only/.test(passive.detail), JSON.stringify(passive));
      const gate = await insight.corsPreflightGate(srcTexts, { timeoutMs: 3000, probe: true });
      check('gate warns overall', gate.status === 'warn', JSON.stringify(gate).slice(0, 300));
      check('missing-ACAO server flagged', gate.detail.includes(badO) && /missing_acao/.test(gate.detail), gate.detail);
      check('wrong-origin ACAO flagged', gate.detail.includes(wrongO), gate.detail);
      check('permissive server NOT flagged', !gate.detail.includes(goodO), gate.detail);
      check("insight says fix belongs to the SERVER", /SERVER/.test(gate.insight?.fix ?? ''), JSON.stringify(gate.insight));
      const httpExt = await insight.probeCorsOrigin('http://api.example.com');
      check('external http origin warns secure-context without probing', httpExt.status === 'warn' && httpExt.problem === 'insecure_http', JSON.stringify(httpExt));
      const goodProbe = await insight.probeCorsOrigin(goodO, { timeoutMs: 3000 });
      check('probe of permissive local server is ok', goodProbe.status === 'ok' && goodProbe.acao === '*', JSON.stringify(goodProbe));
      note('local mock servers: no-ACAO, ACAO:*, ACAO:evil.example');
    } finally {
      bad.close(); good.close(); wrong.close();
    }
  },

  // Report 41 §6.1 / review 42 R41-5: an uncaught value that is NOT an Error must still be
  // diagnosable from evidence alone. `pageerror` cannot carry it (playwright flattens the
  // payload to Error("Object") before node sees it) — the runner's in-page capture must.
  async 'pageerror-object-detail'({ ws, check, note }) {
    const fixture = path.join(LAB_ROOT, 'evaluation', 'browser', 'fixtures', 'throw-object.html');
    if (!fs.existsSync(fixture)) return 'blocked: evaluation/browser/fixtures/throw-object.html missing';
    const outDir = path.join(ws, 'evidence');
    const runner = path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'scripts', 'browser', 'runner.mjs');
    const res = spawnSync(process.execPath, [
      runner, '--url', pathToFileURL(fixture).href, '--out', outDir, '--profile', 'official-template',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    check('runner exits 1 (uncaught payload is still fatal)', res.status === 1,
      `exit ${res.status}: ${(res.stderr || res.stdout || '').slice(-300)}`);

    const lines = fs.existsSync(path.join(outDir, 'console.jsonl'))
      ? fs.readFileSync(path.join(outDir, 'console.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const detail = lines.filter((l) => l.kind === 'error-detail');
    const pageerror = lines.filter((l) => l.kind === 'pageerror');

    check('pageerror line still records only the flattened text (bug reproduced, not hidden)',
      pageerror.length > 0 && pageerror.every((l) => !String(l.text).includes('NEGATIVE_CONTROL')),
      JSON.stringify(pageerror.slice(0, 2)));
    check('window.onerror payload keeps the nested field',
      detail.some((l) => l.source === 'window.onerror' && String(l.text).includes('NEGATIVE_CONTROL_NESTED_VALUE')
        && String(l.text).includes('"code":-2000')),
      JSON.stringify(detail.filter((l) => l.source === 'window.onerror').slice(0, 1)));
    check('unhandledrejection payload keeps the nested field',
      detail.some((l) => l.source === 'unhandledrejection' && String(l.text).includes('NEGATIVE_CONTROL_REJECTION_VALUE')),
      JSON.stringify(detail.filter((l) => l.source === 'unhandledrejection').slice(0, 1)));

    const cfg = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'config.json'));
    const vpNames = (cfg?.viewports ?? []).map((v) => v.name);
    check('every viewport captured the payload, not just the default one',
      vpNames.length > 0 && vpNames.every((v) => detail.some((l) => l.viewport === v)),
      JSON.stringify({ vpNames, seen: [...new Set(detail.map((l) => l.viewport))] }));

    // The detail lines are evidence only: the fatal counter must still be exactly the number
    // of pageerror events per viewport (2 here), never inflated by the capture.
    const gatesJson = readJsonIfExists(path.join(outDir, 'gates.json'));
    const fatal = (gatesJson?.gates ?? []).filter((g) => g.id === 'no_fatal_console_error');
    check('no_fatal_console_error counts pageerror only (error-detail is not counted)',
      fatal.length === vpNames.length && fatal.every((g) => g.status === 'fail' && /^2 error\/pageerror event\(s\)/.test(g.detail)),
      JSON.stringify(fatal));
    note(`error-detail lines: ${detail.length}, pageerror lines: ${pageerror.length}`);
  },

  // Phase 2.6 Tier-2: curated signature map turns a known log line into a diagnosis.
  async 'signature-match'({ ws, check, note }) {
    const sigPath = path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'references', 'error-signatures.json');
    if (!fs.existsSync(sigPath)) {
      return 'blocked: references/error-signatures.json not curated yet (Subagent A)';
    }
    const insight = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'insight.mjs')).href);
    const fixtureLog = 'Uncaught Error: Minified React error #310; visit https://react.dev/errors/310 for the full message\n';
    const matches = insight.matchSignatures(fixtureLog);
    check('signature matches the React minified error', matches.length >= 1, JSON.stringify(insight.loadSignatures().map((s) => s.id)));
    const m = matches[0];
    check('match carries diagnosis + fix + source', !!m?.diagnosis && !!m?.fix && m?.source != null, JSON.stringify(m));
    // Integration: the insight rides on a finding (finding.schema.json optional field).
    const { newRunId } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'lib', 'run-context.mjs')).href);
    const rf = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'record-finding.mjs')).href);
    const rec = rf.recordFinding({
      workspace: ws, runId: newRunId(), stage: 'render', category: 'app', severity: 'major',
      expected: 'no fatal console errors', actual: 'minified react error #310 in console', insight: m,
    });
    check('recordFinding persists the insight', rec.insight?.diagnosis === m.diagnosis && rec.insight?.fix === m.fix,
      JSON.stringify(rec.insight));
    check('unknown text matches nothing (no guessing)', insight.matchSignatures('everything is fine here').length === 0, '');
    note(`matched signature id: ${m?.id}`);
  },

  // Phase 2.6 §3.2: single entry chains the pipeline and forwards stage JSON on stop.
  async 'run-entry'({ ws, check }) {
    // (1) missing App ID → stops at bootstrap, exit 2, needs_input forwarded verbatim.
    const stop = runScript(ws, 'run', ['--brief', 'tạo app bán quần áo']);
    check('run.mjs exits 2 when App ID missing', stop.code === 2, `exit ${stop.code}`);
    check('final JSON: stoppedAt bootstrap + status needs_input forwarded',
      stop.lastJson?.stoppedAt === 'bootstrap' && stop.lastJson?.exitCode === 2 && stop.lastJson?.status === 'needs_input',
      JSON.stringify(stop.lastJson));

    // (2) happy path (lab template, NO deploy) in a fresh workspace.
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws, { recursive: true });
    const happy = runScript(ws, 'run', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('run.mjs exits 0 on happy path', happy.code === 0, `exit ${happy.code}: ${(happy.stderr || happy.stdout).slice(-400)}`);
    check('final JSON: status pass with runId + resultPath + insights count',
      happy.lastJson?.status === 'pass' && !!happy.lastJson?.runId
        && typeof happy.lastJson?.insights === 'number' && !!happy.lastJson?.resultPath,
      JSON.stringify(happy.lastJson));
    const result = readJsonIfExists(happy.lastJson?.resultPath ?? '');
    check('result.json exists and passes', result?.status === 'pass' && result?.stage === 'done',
      JSON.stringify({ status: result?.status, stage: result?.stage }));
    check('no deploy ran (no deploy evidence)', !fs.existsSync(path.join(ws, 'runs', happy.lastJson?.runId ?? 'x', 'evidence', 'deploy.log')), '');
  },

  // ---- Phase 3 simulator cases (plan 28) ----

  // Mandate 42 §3.4: zaui-lucky-wheel@8c692b9 embedded an App Secret and called the Zalo Graph
  // endpoint from the browser, and its register form caught every error, showed a "success"
  // snackbar and filled a hardcoded fake phone number. The pinned adapter must remove the
  // server-side call, mock ONLY under the DX simulator marker (labelled), and fail closed
  // everywhere else — including inside a real Zalo host, which is indistinguishable from the
  // simulator by URL, hostname or user-agent. Both directions are run for real, on one build.
  async 'lucky-wheel-phone-fail-closed'({ ws, check, note }) {
    const TEMPLATE_ID = 'zaui-lucky-wheel';
    const registry = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'catalog', 'templates.json'));
    const profile = (registry?.templates ?? []).find((t) => t.id === TEMPLATE_ID);
    if (!profile?.qualification?.adapterId) {
      return `blocked: ${TEMPLATE_ID} has no adapterId in the registry — qualify it first`;
    }

    const boot = runScript(ws, 'bootstrap', [
      '--brief', 'tạo app vòng quay may mắn', '--app-id', TEST_APP_ID, '--template', `official:${TEMPLATE_ID}`,
    ]);
    check('bootstrap scaffolds the template', boot.code === 0, `exit ${boot.code}: ${(boot.stderr || boot.stdout).slice(-400)}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;

    const adapterEvidence = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'adapter.json'));
    check('bootstrap applied the pinned adapter and recorded it',
      adapterEvidence?.adapterId === profile.qualification.adapterId
        && adapterEvidence?.upstreamRevision === profile.source.revision
        && (adapterEvidence?.patches ?? []).length > 0,
      JSON.stringify(adapterEvidence));

    // The security property, checked on the tree the user actually gets.
    const srcFiles = [];
    const stack = [path.join(ws, 'app', 'src')];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['www', 'dist', 'node_modules'].includes(e.name)) stack.push(full); }
        else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) srcFiles.push(full);
      }
    }
    const offenders = srcFiles.filter((f) => /graph\.zalo\.me|secret_key\s*[:=]|app_secret\s*[:=]|private_key\s*[:=]/i
      .test(fs.readFileSync(f, 'utf8')));
    check('client source carries no server-side endpoint and no secret literal', offenders.length === 0,
      JSON.stringify(offenders.map((f) => path.relative(ws, f))));

    for (const step of ['install', 'build']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
      if (r.code !== 0) return;
    }

    // Drive the built app twice through the SHIPPED sim serving code (not a copy of it).
    const { chromium } = await import('playwright-core');
    const { openRun } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'lib', 'run-context.mjs')).href);
    const { resolveWorkspace } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'lib', 'paths.mjs')).href);
    const { buildSimManifest, setupSimContext, simUrl } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'sim', 'intercept.mjs')).href);
    const wsObj = resolveWorkspace(['--workspace', ws]);
    const manifest = buildSimManifest(openRun(path.join(ws, 'runs'), runId), wsObj, { decision: 'accept' });
    const SIM_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Zalo android/24112050';

    // `suppressMarker` reproduces a REAL Zalo host: same hostname, same path, same shim, same
    // working SDK — only the DX marker is absent. That is the exact situation a mock must never
    // leak into, and no URL/UA check could tell it apart.
    const drive = async ({ suppressMarker }) => {
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      const graphRequests = [];
      try {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 }, userAgent: SIM_UA, ignoreHTTPSErrors: true,
        });
        await setupSimContext(context, manifest);
        if (suppressMarker) {
          // Accessor with no setter: the injected inline script is a classic (sloppy-mode)
          // script, so its assignment is a silent no-op and the marker stays undefined.
          await context.addInitScript(() => {
            Object.defineProperty(window, '__ZMP_DX_RUNTIME__', { get: () => undefined, configurable: false });
          });
        }
        const page = await context.newPage();
        page.on('request', (r) => { if (/graph\.zalo\.me/.test(r.url())) graphRequests.push(r.url()); });
        await page.goto(simUrl(manifest.appId), { waitUntil: 'load', timeout: 30000 });
        await page.waitForSelector('#app', { state: 'attached', timeout: 15000 });
        const markerSeen = await page.evaluate(() => window.__ZMP_DX_RUNTIME__?.mode ?? null);
        const phoneInput = page.locator('input[type="tel"]').first();
        await phoneInput.click({ timeout: 10000 });          // triggers the autofill request
        await page.waitForTimeout(1500);
        const out = {
          markerSeen,
          phoneValue: await phoneInput.inputValue(),
          simBadge: await page.locator('[data-testid="phone-sim-badge"]').count(),
          backendRequired: await page.locator('[data-testid="phone-backend-required"]').count(),
          bodyText: (await page.locator('body').innerText()).slice(0, 4000),
        };
        await phoneInput.fill('0912345678');                  // manual input must stay usable
        out.manualValue = await phoneInput.inputValue();
        out.graphRequests = graphRequests;
        await context.close();
        return out;
      } finally {
        await browser.close();
      }
    };

    const sim = await drive({ suppressMarker: false });
    const expectedMock = manifest.simConfig?.persona?.phoneNumber ?? '0000000000';
    check('simulator: marker visible to the app', sim.markerSeen === 'simulator', JSON.stringify(sim.markerSeen));
    check('simulator: phone filled with the mock number', sim.phoneValue === expectedMock,
      JSON.stringify({ got: sim.phoneValue, expected: expectedMock }));
    check('simulator: "dữ liệu giả lập" badge is shown', sim.simBadge === 1 && /GIẢ LẬP/.test(sim.bodyText),
      JSON.stringify({ badge: sim.simBadge }));
    check('simulator: no real Graph request', sim.graphRequests.length === 0, JSON.stringify(sim.graphRequests));

    const prod = await drive({ suppressMarker: true });
    check('production-like: marker really is absent', prod.markerSeen === null, JSON.stringify(prod.markerSeen));
    check('production-like: phone field left EMPTY — no mock, no invented number',
      prod.phoneValue === '' && !prod.bodyText.includes(expectedMock),
      JSON.stringify({ value: prod.phoneValue }));
    check('production-like: backend-required notice shown, simulator badge not shown',
      prod.backendRequired === 1 && prod.simBadge === 0 && /nhập số điện thoại thủ công/.test(prod.bodyText),
      JSON.stringify({ backendRequired: prod.backendRequired, simBadge: prod.simBadge }));
    check('production-like: manual input still usable', prod.manualValue === '0912345678', JSON.stringify(prod.manualValue));
    check('production-like: no real Graph request', prod.graphRequests.length === 0, JSON.stringify(prod.graphRequests));

    const verify = runScript(ws, 'verify', ['--run-id', runId]);
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    const warn = (result?.warnings ?? []).find((w) => w.code === 'PHONE_BACKEND_REQUIRED');
    check('verify wrote a structured warning separating preview from production feature',
      !!warn && warn.blockingForPreview === false && warn.blockingForProductionFeature === true
        && warn.affectedFeature === 'phone-number-autofill' && warn.fallback === 'manual-input'
        && typeof warn.guide === 'string' && warn.source === adapterEvidence.adapterId,
      `verify exit ${verify.code}: ${JSON.stringify(result?.warnings)}`);
    check('the guide the warning points at exists',
      !!warn && fs.existsSync(path.join(LAB_ROOT, 'skill', 'create-zmp-app', warn.guide)), warn?.guide);
    note(`adapter ${adapterEvidence?.adapterId} · patches ${(adapterEvidence?.patches ?? []).join(', ')}`);
  },

  // Mandate 42 §3.2: the DX runtime marker is the ONLY thing separating simulator from
  // production, because the simulator deliberately serves from the real hostname and path.
  // Both directions are the contract: present under sim serving, absent everywhere else.
  async 'sim-runtime-marker'({ ws, check, note }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const runId = simBuildPipeline(ws, check);
    if (!runId) return;
    const gatesOf = () => readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'))?.gates ?? [];
    const domOf = () => readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'dom.json'))?.viewports ?? {};

    const sim = runScript(ws, 'render', ['--run-id', runId, '--provider', 'simulator', '--sim-decision', 'accept']);
    check('render (simulator) exits 0', sim.code === 0, `exit ${sim.code}: ${(sim.stderr || sim.stdout).slice(-400)}`);
    const simMarkerGates = gatesOf().filter((g) => g.id === 'sim_runtime_marker');
    check('sim_runtime_marker passes on every viewport',
      simMarkerGates.length === 3 && simMarkerGates.every((g) => g.status === 'pass'),
      JSON.stringify(simMarkerGates));
    const simDom = Object.values(domOf());
    check('marker read back from the page is schemaVersion 1 / mode simulator',
      simDom.length === 3 && simDom.every((v) => v.dxRuntime?.schemaVersion === 1 && v.dxRuntime?.mode === 'simulator' && v.dxRuntime?.hasMockData),
      JSON.stringify(simDom.map((v) => v.dxRuntime)));

    const plain = runScript(ws, 'render', ['--run-id', runId]);
    check('render (no simulator) exits 0', plain.code === 0, `exit ${plain.code}: ${(plain.stderr || plain.stdout).slice(-400)}`);
    const plainMarkerGates = gatesOf().filter((g) => g.id === 'no_sim_runtime_marker');
    check('no_sim_runtime_marker passes on every viewport — nothing leaked',
      plainMarkerGates.length === 3 && plainMarkerGates.every((g) => g.status === 'pass'),
      JSON.stringify(plainMarkerGates));
    check('no sim_runtime_marker gate in a non-simulator run', !gatesOf().some((g) => g.id === 'sim_runtime_marker'),
      JSON.stringify(gatesOf().map((g) => g.id)));
    check('marker absent from the page in a non-simulator run',
      Object.values(domOf()).every((v) => v.dxRuntime === null),
      JSON.stringify(Object.values(domOf()).map((v) => v.dxRuntime)));

    // Serve-time only: the built artefact on disk must never carry the marker, or a deploy
    // would ship a page that believes it is running in a simulator.
    const outDir = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'build-info.json'))?.outDir ?? 'dist';
    const distIndex = path.join(ws, 'app', outDir, 'index.html');
    check('built index.html on disk contains no marker',
      fs.existsSync(distIndex) && !fs.readFileSync(distIndex, 'utf8').includes('__ZMP_DX_RUNTIME__'), distIndex);
    note('marker is injected in memory by scripts/sim/intercept.mjs, never written to dist');
  },

  async 'sim-accept'({ ws, check }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const runId = simBuildPipeline(ws, check);
    if (!runId) return;
    const render = runScript(ws, 'render', ['--run-id', runId, '--provider', 'simulator', '--sim-decision', 'accept']);
    check('render (simulator, accept) exits 0', render.code === 0, `exit ${render.code}: ${(render.stderr || render.stdout).slice(-400)}`);
    const gates = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'))?.gates ?? [];
    const simGates = gates.filter((g) => g.id.startsWith('sim_demo_') && g.id !== 'sim_demo_nav');
    check('4 sim_demo_* gates all pass', simGates.length >= 4 && simGates.every((g) => g.status === 'pass'),
      JSON.stringify(simGates.map((g) => [g.id, g.status, g.detail?.slice(0, 60)])));
    const log = readBridgeLog(ws, runId);
    const demoApis = ['getUserInfo', 'getLocation', 'getPhoneNumber', 'getAccessToken'];
    check('bridge-log covers the 4 demo APIs', demoApis.every((a) => log.some((e) => e.api === a)),
      JSON.stringify([...new Set(log.map((e) => e.api))]));
    check('bridge-log shows the settings/login infra path (SDK pre-check alive from load)',
      log.some((e) => e.api === 'getSetting' || e.api === 'jumpLogin' || e.api === 'login'),
      JSON.stringify(log.slice(0, 5)));
    check('no unmocked entries in accept flow', !log.some((e) => e.unmocked), JSON.stringify(log.filter((e) => e.unmocked)));
    const verify = runScript(ws, 'verify', ['--run-id', runId]);
    check('verify exits 0', verify.code === 0, `exit ${verify.code}: ${(verify.stderr || verify.stdout).slice(-400)}`);
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result pass, schemaVersion 1.1, gate no_unmocked_silent_success pass',
      result?.status === 'pass' && result?.schemaVersion === '1.1'
        && result?.gates?.some((g) => g.id === 'no_unmocked_silent_success' && g.status === 'pass'),
      JSON.stringify({ status: result?.status, v: result?.schemaVersion }));
  },

  async 'sim-deny'({ ws, check, note }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const registry = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'references', 'sim-mock-data.json'));
    const runId = simBuildPipeline(ws, check);
    if (!runId) return;
    const render = runScript(ws, 'render', ['--run-id', runId, '--provider', 'simulator', '--sim-decision', 'deny']);
    // Known contract gap (reported to lead): registry pins getAccessToken requiresPermission=false,
    // so it succeeds even in deny mode while the runner expects an error marker for every API.
    const gatesDeny = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'))?.gates ?? [];
    const denyFailed = gatesDeny.filter((g) => g.status === 'fail').map((g) => g.id);
    check('render deny: exit 0, or failing ONLY on the known getAccessToken gap',
      render.code === 0 || (render.code === 1 && denyFailed.every((id) => id === 'sim_demo_getAccessToken')),
      `exit ${render.code}; failed gates: ${JSON.stringify(denyFailed)}`);
    check('permissioned demo gates (getUserInfo/getLocation/getPhoneNumber) all pass in deny mode',
      ['getUserInfo', 'getLocation', 'getPhoneNumber'].every((a) => gatesDeny.some((g) => g.id === `sim_demo_${a}` && g.status === 'pass')),
      JSON.stringify(gatesDeny.filter((g) => g.id.startsWith('sim_demo_'))));
    const log = readBridgeLog(ws, runId);
    for (const api of ['getLocation', 'getPhoneNumber', 'getUserInfo']) {
      const expected = registry?.apis?.[api]?.denyError?.error_code;
      const entry = log.find((e) => e.api === api && (e.decision === 'deny' || e.decision === 'already-denied'));
      check(`deny path for ${api} logs registry denyError code ${expected}`,
        entry != null && entry.error_code === expected, JSON.stringify(log.filter((e) => e.api === api)));
    }
    note('getAccessToken requiresPermission=false in the registry — succeeds even in deny mode (reported as-is)');
  },

  async 'sim-manual-sheet'({ ws, check }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const runId = simBuildPipeline(ws, check);
    if (!runId) return;
    const render = runScript(ws, 'render', ['--run-id', runId, '--provider', 'simulator', '--sim-decision', 'manual']);
    const gates = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'))?.gates ?? [];
    // Same known gap as sim-deny: no sheet for permission-less getAccessToken, runner waits for one.
    const manualFailed = gates.filter((g) => g.status === 'fail').map((g) => g.id);
    check('render manual: exit 0, or failing ONLY on the known getAccessToken gap',
      render.code === 0 || (render.code === 1 && manualFailed.every((id) => id === 'sim_demo_getAccessToken')),
      `exit ${render.code}; failed gates: ${JSON.stringify(manualFailed)}`);
    check('permissioned demo gates pass via the manual sheet',
      ['getUserInfo', 'getLocation', 'getPhoneNumber'].every((a) => gates.some((g) => g.id === `sim_demo_${a}` && g.status === 'pass')),
      JSON.stringify(gates.filter((g) => g.id.startsWith('sim_demo_'))));
    check('gate sim_sheet_badge pass (SIMULATOR badge on the sheet)',
      gates.some((g) => g.id === 'sim_sheet_badge' && g.status === 'pass'),
      JSON.stringify(gates.filter((g) => g.id.startsWith('sim_sheet'))));
    check('no lingering sheet after flows', !gates.some((g) => g.id === 'sim_sheet_closed' && g.status === 'fail'),
      JSON.stringify(gates.filter((g) => g.id === 'sim_sheet_closed')));
  },

  async 'sim-unmocked'({ ws, check, note }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    for (const step of ['install', 'build']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
      if (r.code !== 0) return;
    }
    const { chromium } = await import('playwright-core'); // resolves from lab root node_modules
    const { setupSimContext, buildSimManifest, simUrl } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'sim', 'intercept.mjs')).href);
    const { openRun } = await libRunContext();
    const ctx = openRun(path.join(ws, 'runs'), runId);
    const manifest = buildSimManifest(ctx, { appDir: path.join(ws, 'app') }, { decision: 'accept' });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, userAgent: SIM_CASE_UA, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
      });
      await setupSimContext(context, manifest);
      const page = await context.newPage();
      await page.goto(simUrl(TEST_APP_ID), { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1500); // let the bundle + auto-login settle
      // The bundle tree-shakes the SDK global (only getVersion survives), so the un-mocked
      // API is exercised at the REAL transport boundary: a jsCall with an out-of-registry
      // action and the Android-shaped callback string (sdkHostContract.call).
      const res = await page.evaluate(() => new Promise((resolve) => {
        const captured = {};
        const prior = window.onNativeMessage;
        window.onNativeMessage = (sid, act) => (json) => {
          captured.resp = { sid, act, json };
          if (typeof prior === 'function') { try { prior(sid, act)(json); } catch (e) { /* sdk side */ } }
        };
        window.ZaloJavaScriptInterface.jsCall('', 'action.scan.qr.code', '', '{}',
          'window.onNativeMessage("SCAN_QR_CODE_424242", "action.scan.qr.code")');
        setTimeout(() => resolve(captured.resp ?? null), 800);
      }));
      let parsed = null;
      try { parsed = JSON.parse(res?.json ?? 'null'); } catch { /* not json */ }
      check('un-registry jsCall answers loudly with a non-zero error_code (never silent success)',
        parsed != null && parsed.error_code === -1 && /not supported in simulator/.test(parsed.error_message ?? ''),
        JSON.stringify(res));
      note(`transport response: ${JSON.stringify(parsed).slice(0, 140)} (SDK global is tree-shaken — only getVersion — so the boundary is tested directly)`);
    } finally {
      await browser.close();
    }
    const log = readBridgeLog(ws, runId);
    check('bridge-log has an unmocked entry with non-zero error_code',
      log.some((e) => e.unmocked && typeof e.error_code === 'number' && e.error_code !== 0),
      JSON.stringify(log.filter((e) => e.unmocked)));
    const verify = runScript(ws, 'verify', ['--run-id', runId]);
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('verify gate no_unmocked_silent_success passes (loud failure is the contract)',
      result?.gates?.some((g) => g.id === 'no_unmocked_silent_success' && g.status === 'pass'),
      JSON.stringify({ verifyExit: verify.code, gate: result?.gates?.find((g) => g.id === 'no_unmocked_silent_success') }));
  },

  async 'sim-permission-persist'({ ws, check, note }) {
    const missing = simDepsMissing();
    if (missing.length) return `blocked: ${missing.join('; ')}`;
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    for (const step of ['install', 'build']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
      if (r.code !== 0) return;
    }
    const cfg = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'config.json'));
    const sd = cfg.simulatorDemo;
    const { chromium } = await import('playwright-core');
    const { setupSimContext, buildSimManifest, simUrl } = await import(pathToFileURL(path.join(SKILL_SCRIPTS, 'sim', 'intercept.mjs')).href);
    const { openRun } = await libRunContext();
    const ctx = openRun(path.join(ws, 'runs'), runId);
    const manifest = buildSimManifest(ctx, { appDir: path.join(ws, 'app') }, { decision: 'accept' });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, userAgent: SIM_CASE_UA, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true,
      });
      await setupSimContext(context, manifest);
      const page = await context.newPage();
      await page.goto(simUrl(TEST_APP_ID), { waitUntil: 'load', timeout: 20000 });
      await page.locator(sd.navMarker).first().click({ timeout: 10000 });
      const btn = sd.buttonMarker.replace('<name>', 'getLocation');
      const resultSel = sd.resultMarker.replace('<name>', 'getLocation');
      await page.locator(btn).first().click({ timeout: 5000 });
      await page.waitForFunction((sel) => (document.querySelector(sel)?.textContent || '').trim().length > 0, resultSel, { timeout: 8000 });
      await page.locator(btn).first().click({ timeout: 5000 });
      await page.waitForTimeout(800); // second bridge round-trip
      check('no permission sheet ever appeared (accept mode + persisted grant)',
        await page.locator(sd.sheetMarkers.sheet).count() === 0, '');
    } finally {
      await browser.close();
    }
    const entries = readBridgeLog(ws, runId).filter((e) => e.api === 'getLocation');
    check('first getLocation call decided "accept" (fresh grant persisted)',
      entries[0]?.decision === 'accept', JSON.stringify(entries));
    check('second getLocation call decided "already-granted" (store persisted)',
      entries.length >= 2 && entries[1]?.decision === 'already-granted', JSON.stringify(entries));
    note(`bridge decisions for getLocation: ${entries.map((e) => e.decision).join(' → ')}`);
  },

  // v0.3.1 P0 regression — safe rerun must never clobber user-edited app code.
  'preserve-user-code'({ ws, check, note }) {
    // Toàn bộ case này kiểm tra hành vi giữ code user trên LAB template. Từ plan 34, brief
    // "bán quần áo" tự route sang zaui-fashion, nên mọi lần gọi phải pin lab; riêng --existing
    // không được đi kèm --template (bootstrap từ chối tổ hợp đó).
    const args = ['--brief', 'tạo app bán quần áo', '--app-id', TEST_APP_ID, '--template', 'lab'];
    const argsNoTemplate = args.filter((a, i) => a !== '--template' && args[i - 1] !== '--template');
    const boot = runScript(ws, 'bootstrap', args);
    check('bootstrap exits 0', boot.code === 0, `exit ${boot.code}: ${boot.stderr.slice(-200)}`);
    const appTsx = path.join(ws, 'app', 'src', 'app.tsx');
    if (!fs.existsSync(appTsx)) { check('app/src/app.tsx scaffolded', false, appTsx); return; }
    check('scaffold manifest written', fs.existsSync(path.join(ws, 'app', '.scaffold-manifest.json')), '');

    // (1) idempotent rerun on an untouched app is still allowed
    const idem = runScript(ws, 'bootstrap', args);
    check('untouched rerun exits 0 (idempotent)', idem.code === 0, `exit ${idem.code}: ${idem.stderr.slice(-200)}`);

    // (2) user edit + default rerun → stop BEFORE mutation, sentinel intact
    const sentinel = `// USER_SENTINEL_${crypto.randomBytes(6).toString('hex')}`;
    fs.appendFileSync(appTsx, `\n${sentinel}\n`);
    const re = runScript(ws, 'bootstrap', args);
    check('rerun over edited app exits 2', re.code === 2, `exit ${re.code}: ${re.stderr.slice(-200)}`);
    check('stdout status needs_input', re.lastJson?.status === 'needs_input', JSON.stringify(re.lastJson));
    const result = readJsonIfExists(path.join(ws, 'runs', re.lastJson?.runId ?? 'x', 'result.json'));
    check('needsInput.reason existing_app', result?.needsInput?.reason === 'existing_app', JSON.stringify(result?.needsInput));
    check('sentinel survives the refused rerun', fs.readFileSync(appTsx, 'utf8').includes(sentinel), '');

    // (3) --existing keeps the code and proceeds
    const ex = runScript(ws, 'bootstrap', [...argsNoTemplate, '--existing']);
    check('--existing exits 0', ex.code === 0, `exit ${ex.code}: ${ex.stderr.slice(-200)}`);
    check('sentinel survives --existing', fs.readFileSync(appTsx, 'utf8').includes(sentinel), '');
    const input = readJsonIfExists(path.join(ws, 'runs', ex.lastJson?.runId ?? 'x', 'input.json'));
    check('input.json template.source=lab (provenance inherited from manifest)',
      input?.template?.source === 'lab', JSON.stringify(input?.template));

    // (4) --force-scaffold is the explicit, user-authorized overwrite
    const fo = runScript(ws, 'bootstrap', [...args, '--force-scaffold']);
    check('--force-scaffold exits 0', fo.code === 0, `exit ${fo.code}: ${fo.stderr.slice(-200)}`);
    check('sentinel gone after --force-scaffold', !fs.readFileSync(appTsx, 'utf8').includes(sentinel), '');

    // (5) user-ADDED files are neither absorbed into the manifest nor blocking: a foreign
    // file outside the template write-set survives a rerun, may be edited freely, and the
    // rewritten manifest never claims it (write-set-only manifest).
    const customFile = path.join(ws, 'app', 'src', 'lib', 'custom.ts');
    fs.mkdirSync(path.dirname(customFile), { recursive: true });
    fs.writeFileSync(customFile, 'export const mine = 1;\n');
    const withCustom = runScript(ws, 'bootstrap', args);
    check('rerun with user-added file exits 0 (not a collision — path not in write-set)',
      withCustom.code === 0, `exit ${withCustom.code}: ${withCustom.stderr.slice(-200)}`);
    const manifest = readJsonIfExists(path.join(ws, 'app', '.scaffold-manifest.json'));
    check('manifest never claims the user-added file', manifest && !('src/lib/custom.ts' in (manifest.files ?? {})),
      JSON.stringify(Object.keys(manifest?.files ?? {}).filter((f) => f.includes('custom'))));
    fs.appendFileSync(customFile, '// edited\n');
    const editedCustom = runScript(ws, 'bootstrap', args);
    check('editing the user-added file never triggers existing_app', editedCustom.code === 0,
      `exit ${editedCustom.code}: ${JSON.stringify(editedCustom.lastJson)}`);

    // (6) template identity: a pristine app scaffolded from ANOTHER template must not be
    // silently re-scaffolded into a hybrid. Simulated by rewriting manifest.template.
    const m2 = readJsonIfExists(path.join(ws, 'app', '.scaffold-manifest.json'));
    m2.template = { source: 'official', id: 'zaui-coffee' };
    fs.writeFileSync(path.join(ws, 'app', '.scaffold-manifest.json'), JSON.stringify(m2, null, 2) + '\n');
    const tplSwitch = runScript(ws, 'bootstrap', args);
    check('template switch on pristine app exits 2 (template_changed)', tplSwitch.code === 2,
      `exit ${tplSwitch.code}: ${JSON.stringify(tplSwitch.lastJson)}`);
    const tplResult = readJsonIfExists(path.join(ws, 'runs', tplSwitch.lastJson?.runId ?? 'x', 'result.json'));
    check('template_changed reported as existing_app with template names in the question',
      tplResult?.needsInput?.reason === 'existing_app' && /zaui-coffee/.test(tplResult?.needsInput?.question ?? ''),
      JSON.stringify(tplResult?.needsInput));
    m2.template = { source: 'lab', id: 'lab-template' };
    fs.writeFileSync(path.join(ws, 'app', '.scaffold-manifest.json'), JSON.stringify(m2, null, 2) + '\n');

    // (7) write-set collision: a file the incoming template owns but the manifest does not
    // (simulated by dropping its manifest entry) must stop pre-copy, file intact.
    const m3 = readJsonIfExists(path.join(ws, 'app', '.scaffold-manifest.json'));
    delete m3.files['src/app.tsx'];
    fs.writeFileSync(path.join(ws, 'app', '.scaffold-manifest.json'), JSON.stringify(m3, null, 2) + '\n');
    const beforeCollision = fs.readFileSync(appTsx, 'utf8');
    const collision = runScript(ws, 'bootstrap', args);
    check('unowned-file collision exits 2, nothing copied', collision.code === 2 && fs.readFileSync(appTsx, 'utf8') === beforeCollision,
      `exit ${collision.code}: ${JSON.stringify(collision.lastJson)}`);
    note('flow: scaffold → idempotent → edit→refused → --existing keeps → force overwrites → added-file free → template_changed + collision stop');
  },

  // v0.3.1 P0 regression — workspace defaults to process.cwd(), NEVER the package location.
  // Models the Claude plugin cache: the whole repo (incl. evaluation/cases) sits above the
  // package; the old marker heuristic wrote runs/ into the cache instead of the user's cwd.
  'workspace-default-cwd'({ ws, check, note }) {
    const pkg = path.join(ws, 'skill', 'create-zmp-app');
    fs.cpSync(path.join(LAB_ROOT, 'skill', 'create-zmp-app'), pkg, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`),
    });
    fs.mkdirSync(path.join(ws, 'evaluation', 'cases'), { recursive: true }); // the old IN_LAB marker
    const userDir = path.join(ws, 'userdir');
    fs.mkdirSync(userDir, { recursive: true });
    const env = { ...process.env };
    delete env.MB_WORKSPACE;
    const res = spawnSync(process.execPath, [path.join(pkg, 'scripts', 'bootstrap.mjs'),
      '--brief', 'tạo app bán quần áo', '--app-id', TEST_APP_ID, '--template', 'lab'], {
      cwd: userDir, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    check('bootstrap (no --workspace) exits 0', res.status === 0, `exit ${res.status}: ${String(res.stderr).slice(-300)}`);
    check('output lands in the user cwd',
      fs.existsSync(path.join(userDir, 'app', 'package.json')) && fs.existsSync(path.join(userDir, 'runs')), '');
    check('package root (plugin cache stand-in) stays clean',
      !fs.existsSync(path.join(ws, 'app')) && !fs.existsSync(path.join(ws, 'runs')) && !fs.existsSync(path.join(pkg, 'runs')), '');
    const envFile = path.join(userDir, 'app', '.env');
    check('.env APP_ID bound in the cwd workspace',
      fs.existsSync(envFile) && new RegExp(`^APP_ID=${TEST_APP_ID}$`, 'm').test(fs.readFileSync(envFile, 'utf8')), '');
    note('package copied under <ws>/skill/create-zmp-app with evaluation/cases beside it — output still lands at cwd');
  },

  // v0.3.1 P0 regression — install.sh host targeting: default codex, --host claude/both,
  // node_modules kept only while the lockfile is unchanged. Offline via --src-dir.
  'installer-hosts'({ ws, check, note }) {
    const home = path.join(ws, 'home');
    fs.mkdirSync(home, { recursive: true });
    const run = (args) => spawnSync('bash', [path.join(LAB_ROOT, 'install.sh'), '--src-dir', LAB_ROOT, ...args], {
      cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: home },
    });
    const codexDest = path.join(home, '.codex', 'skills', 'create-zmp-app');
    const claudeDest = path.join(home, '.claude', 'skills', 'create-zmp-app');

    const dflt = run([]);
    check('default install exits 0', dflt.status === 0, String(dflt.stderr).slice(-300));
    check('default installs to ~/.codex/skills', fs.existsSync(path.join(codexDest, 'SKILL.md')), '');
    check('default does NOT touch ~/.claude/skills', !fs.existsSync(claudeDest), '');
    const stamp = fs.existsSync(path.join(codexDest, 'INSTALLED_VERSION'))
      ? fs.readFileSync(path.join(codexDest, 'INSTALLED_VERSION'), 'utf8') : '';
    check('INSTALLED_VERSION stamped with version+ref', /version=.+/.test(stamp) && /ref=/.test(stamp), stamp);

    const claude = run(['--host', 'claude']);
    check('--host claude installs to ~/.claude/skills',
      claude.status === 0 && fs.existsSync(path.join(claudeDest, 'SKILL.md')), String(claude.stderr).slice(-300));

    const marker = path.join(codexDest, 'node_modules', 'KEEP_MARKER');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'x');
    const again = run([]);
    check('reinstall (same lockfile) keeps node_modules', again.status === 0 && fs.existsSync(marker), '');
    fs.appendFileSync(path.join(codexDest, 'pnpm-lock.yaml'), '\n# drift\n');
    const drift = run([]);
    check('reinstall (changed lockfile) drops node_modules', drift.status === 0 && !fs.existsSync(marker), '');

    const both = run(['--host', 'both']);
    check('--host both exits 0', both.status === 0, String(both.stderr).slice(-300));
    check('--host both covers both dests',
      fs.existsSync(path.join(codexDest, 'SKILL.md')) && fs.existsSync(path.join(claudeDest, 'SKILL.md')), '');
    note('all installs offline from --src-dir; source tree never stamped (staging copy only)');
  },

  // v0.3.1 release regression — doctor reports provenance consistently on install.sh,
  // Claude marketplace-plugin, and unsupported manual-copy layouts.
  async 'version-reporting'({ ws, check, note }) {
    const { doctorVersionLine } = await import(pathToFileURL(
      path.join(SKILL_SCRIPTS, 'lib', 'version.mjs'),
    ).href);
    const version = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'package.json'))?.version;
    const writePackage = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'create-zmp-app', version }, null, 2)}\n`);
    };

    const scriptInstall = path.join(ws, 'script-install', 'create-zmp-app');
    writePackage(scriptInstall);
    fs.writeFileSync(path.join(scriptInstall, 'INSTALLED_VERSION'), `version=${version}\nref=v${version}\n`);
    check('install.sh stamp is reported as immutable ref',
      doctorVersionLine(scriptInstall) === `doctor: ok — create-zmp-app v${version} (v${version})`,
      doctorVersionLine(scriptInstall));

    const pluginRoot = path.join(ws, 'home', '.claude', 'plugins', 'cache',
      'zalo-miniapp-skill', 'create-zmp-app', version);
    const pluginSkill = path.join(pluginRoot, 'skill', 'create-zmp-app');
    writePackage(pluginSkill);
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
      name: 'create-zmp-app', version, skills: ['./skill/create-zmp-app'],
    }, null, 2)}\n`);
    check('Claude plugin cache reports manifest version',
      doctorVersionLine(pluginSkill) === `doctor: ok — create-zmp-app v${version} (claude-plugin v${version})`,
      doctorVersionLine(pluginSkill));

    const manual = path.join(ws, 'manual-copy', 'create-zmp-app');
    writePackage(manual);
    check('manual copy remains explicitly unversioned',
      doctorVersionLine(manual) === `doctor: ok — create-zmp-app v${version} (dev copy)`,
      doctorVersionLine(manual));

    const sourceCheckout = path.join(ws, 'source-checkout', 'skill', 'create-zmp-app');
    writePackage(sourceCheckout);
    fs.mkdirSync(path.join(ws, 'source-checkout', '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'source-checkout', '.claude-plugin', 'plugin.json'), `${JSON.stringify({
      name: 'create-zmp-app', version,
    })}\n`);
    check('ordinary source checkout is not mislabeled as installed plugin',
      doctorVersionLine(sourceCheckout).endsWith('(dev copy)'), doctorVersionLine(sourceCheckout));
    note('provenance precedence: install stamp, then matching Claude cache manifest, then dev copy');
  },

  // Addendum Phase 3: doctor auto-installs package deps on a fresh copy of the skill.
  async 'doctor-autoinstall'({ ws, check, note }) {
    const skillDir = path.join(LAB_ROOT, 'skill', 'create-zmp-app');
    const pkgCopy = path.join(ws, 'pkg');
    fs.cpSync(skillDir, pkgCopy, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}node_modules`),
    });
    check('copy has no node_modules', !fs.existsSync(path.join(pkgCopy, 'node_modules')), '');
    const ws2 = path.join(ws, 'target-ws');
    fs.mkdirSync(ws2, { recursive: true });
    const res = spawnSync(process.execPath, [path.join(pkgCopy, 'scripts', 'run.mjs'),
      '--brief', 'tạo app bán quần áo', '--workspace', ws2], {
      cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000,
    });
    check('run.mjs exits 2 (needs_input) after auto-install', res.status === 2,
      `exit ${res.status}: ${String(res.stderr).slice(-400)}`);
    check('stderr shows the first-run setup line', String(res.stderr).includes('first-run setup'), String(res.stderr).slice(0, 300));
    check('node_modules/playwright-core installed in the copy',
      fs.existsSync(path.join(pkgCopy, 'node_modules', 'playwright-core')), '');
    let lastJson = null;
    for (const line of String(res.stdout).trim().split('\n').reverse()) {
      try { lastJson = JSON.parse(line); break; } catch { /* not json */ }
    }
    check('needs_input JSON forwarded', lastJson?.status === 'needs_input' && lastJson?.stoppedAt === 'bootstrap', JSON.stringify(lastJson));
    note('network-dependent (npm registry); doctor is silent apart from the setup line');
  },

  // Phase 2.5 golden: real scaffold from the official zaui-fashion template (network-dependent).
  // No deploy in this case (README: dev slot holds the UAT'd POC build).
  async 'official-template-golden'({ ws, check, note }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo dùng mẫu có sẵn', '--app-id', TEST_APP_ID]);
    if (boot.code !== 0 && /ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH/i.test(boot.stderr + boot.stdout)) {
      return 'blocked: network offline to codeload.github.com';
    }
    check('bootstrap exits 0 (status ok)', boot.code === 0 && boot.lastJson?.status === 'ok',
      `exit ${boot.code}: ${JSON.stringify(boot.lastJson)} ${boot.stderr.slice(-300)}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;

    const input = readJsonIfExists(path.join(ws, 'runs', runId, 'input.json'));
    if (boot.code === 0 && !input?.template) {
      return 'blocked: bootstrap official-template path not landed yet (Subagent A) — input.json has no template field';
    }
    check('input.json template = official/zaui-fashion',
      input?.template?.source === 'official' && input?.template?.id === 'zaui-fashion'
        && /^[0-9a-f]{40}$/.test(input?.template?.revision ?? ''),
      JSON.stringify(input?.template));
    const appCfg = readJsonIfExists(path.join(ws, 'app', 'app-config.json'));
    const title = appCfg?.app?.title ?? appCfg?.title;
    check('app-config.json title = appName', !!input && title === input.appName,
      JSON.stringify({ title, appName: input?.appName }));
    const env = fs.existsSync(path.join(ws, 'app', '.env')) ? fs.readFileSync(path.join(ws, 'app', '.env'), 'utf8') : '';
    check('.env APP_ID bound exactly', new RegExp(`^APP_ID=${TEST_APP_ID}$`, 'm').test(env),
      env.split('\n').filter((l) => l.startsWith('APP_ID')).join());

    for (const step of ['portal-fetch', 'install', 'build']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
      if (r.code !== 0) return;
    }
    const buildInfo = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'build-info.json'));
    check('build-info.json records detected outDir', typeof buildInfo?.outDir === 'string', JSON.stringify(buildInfo));
    note(`detected outDir: ${buildInfo?.outDir}`);

    const render = runScript(ws, 'render', ['--run-id', runId]);
    check('render exits 0 (profile official-template)', render.code === 0, `exit ${render.code}: ${(render.stderr || render.stdout).slice(-400)}`);
    const gates = readJsonIfExists(path.join(ws, 'runs', runId, 'evidence', 'gates.json'))?.gates ?? [];
    check('render gates: react_mount pass, zero fail, marker gates skipped',
      gates.length > 0 && gates.every((g) => g.status !== 'fail')
        && gates.some((g) => g.id === 'react_mount' && g.status === 'pass')
        && gates.some((g) => g.status === 'skipped'),
      JSON.stringify({ fail: gates.filter((g) => g.status === 'fail'), skipped: gates.filter((g) => g.status === 'skipped').length }));
    // finding_2e7f7967bf09 regression: a blank page must never pass again — the runner's
    // mount_not_empty gate (mount has children AND body has text) must pass on every viewport.
    const mne = gates.filter((g) => g.id === 'mount_not_empty');
    check('mount_not_empty pass on all 3 viewports (no blank page)',
      mne.length === 3 && mne.every((g) => g.status === 'pass'), JSON.stringify(mne));

    const ver = runScript(ws, 'verify', ['--run-id', runId]);
    check('verify exits 0', ver.code === 0, `exit ${ver.code}: ${(ver.stderr || ver.stdout).slice(-400)}`);
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json status pass', result?.status === 'pass' && result?.stage === 'done',
      JSON.stringify({ status: result?.status, stage: result?.stage, failed: result?.gates?.filter((g) => g.status === 'fail')?.map((g) => g.id) }));
  },

  // Release-readiness: only an explicitly release-supported, immutable official template
  // may be exposed. Known-but-unverified entries must stop before fetch/app mutation.
  'official-template-support'({ ws, check, note }) {
    const cfg = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'config.json'));
    const supported = cfg?.officialTemplates?.catalog?.filter((e) => e.releaseSupported === true) ?? [];
    check('release-supported catalog is non-empty', supported.length > 0, JSON.stringify(supported));
    check('every supported entry is verified and pinned to a commit SHA',
      supported.every((e) => e.verified === true && /^[0-9a-f]{40}$/.test(e.revision ?? '')),
      JSON.stringify(supported));
    check('zaui-fashion is the only v0.3.1 release-supported template',
      supported.length === 1 && supported[0].id === 'zaui-fashion', JSON.stringify(supported.map((e) => e.id)));

    // The case is about the SUPPORT GATE, not about any one template: it must keep working as
    // templates get qualified. Pick the probe id from the registry at run time — the first
    // still-unqualified template whose brief is known to route to it. Hard-coding zaui-coffee
    // silently turned this case green-then-wrong the day coffee reached render-qualified.
    const registry = readJsonIfExists(path.join(LAB_ROOT, 'skill', 'create-zmp-app', 'catalog', 'templates.json'));
    const AUTO_STATES = new Set(['render-qualified', 'interaction-qualified', 'release-supported']);
    const autoScaffoldable = (id) => {
      const t = (registry?.templates ?? []).find((x) => x.id === id);
      return !!t && AUTO_STATES.has(t.qualification?.state)
        && !!t.source?.revision && t.qualification?.testedRevision === t.source.revision;
    };
    // brief → the template it routes to; every entry needs a corpus case proving the routing.
    const PROBES = [
      { id: 'zaui-uni', brief: 'tạo app cho trường đại học' },
      { id: 'zaui-market', brief: 'tạo app siêu thị tạp hoá' },
      { id: 'zaui-menu', brief: 'tạo app menu quét mã tại bàn' },
    ];
    const probe = PROBES.find((p) => !autoScaffoldable(p.id));
    if (!probe) return 'blocked: every probe template in this case is now auto-scaffoldable — add a still-unqualified probe';

    const byBrief = runScript(ws, 'bootstrap', ['--brief', `${probe.brief} dùng mẫu có sẵn`, '--app-id', TEST_APP_ID]);
    // plan 34 D34-7: cần user chọn template là ASK-USER → exit 2, không còn exit 3.
    check('unsupported keyword route exits 2 before scaffold', byBrief.code === 2,
      `exit ${byBrief.code}: ${byBrief.stderr.slice(-300)}`);
    check('unsupported route returns actionable options',
      byBrief.lastJson?.status === 'needs_template_choice'
        && Array.isArray(byBrief.lastJson?.options)
        && byBrief.lastJson.options.some((o) => o.id === probe.id && typeof o.why === 'string'),
      JSON.stringify(byBrief.lastJson));
    check('unsupported route creates no app and no fetch temp dir',
      !fs.existsSync(path.join(ws, 'app'))
        && !fs.readdirSync(ws).some((name) => name.startsWith('.official-tpl-')), '');

    const explicit = runScript(ws, 'bootstrap', [
      '--brief', probe.brief, '--app-id', TEST_APP_ID, '--template', `official:${probe.id}`,
    ]);
    check('explicit unsupported id is also blocked before fetch',
      explicit.code === 2 && explicit.lastJson?.blocked?.id === probe.id
        && (explicit.lastJson?.blocked?.supported ?? []).includes('zaui-fashion')
        && !fs.existsSync(path.join(ws, 'app')),
      `exit ${explicit.code}: ${JSON.stringify(explicit.lastJson)}`);
    note(`public official catalog: zaui-fashion only; unsupported probe "${probe.id}" never fetches or mutates app/`);
  },

  'golden'({ ws, check }) {
    const boot = runScript(ws, 'bootstrap', ['--brief', 'tạo app bán quần áo', '--template', 'lab', '--app-id', TEST_APP_ID]);
    check('bootstrap exits 0 (status ok)', boot.code === 0 && boot.lastJson?.status === 'ok',
      `exit ${boot.code}: ${JSON.stringify(boot.lastJson)} ${boot.stderr.slice(-200)}`);
    const runId = boot.lastJson?.runId;
    if (!runId) return;
    for (const step of ['portal-fetch', 'install', 'build', 'render', 'verify']) {
      const r = runScript(ws, step, ['--run-id', runId]);
      check(`${step} exits 0`, r.code === 0, `exit ${r.code}: ${(r.stderr || r.stdout).slice(-300)}`);
      if (r.code !== 0) return;
    }
    const result = readJsonIfExists(path.join(ws, 'runs', runId, 'result.json'));
    check('result.json status pass', result?.status === 'pass' && result?.stage === 'done',
      JSON.stringify({ status: result?.status, stage: result?.stage }));
  },
};

// ---------------------------------------------------------------------------
async function main() {
  const caseId = process.argv[2];
  if (!caseId || !SCENARIOS[caseId]) {
    console.error(`usage: run-case.mjs <case-id>\ncases: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(3);
  }
  const caseDir = path.join(CASES_DIR, caseId);
  const caseJson = readJsonIfExists(path.join(caseDir, 'case.json'));
  if (!caseJson) {
    console.error(`run-case: ${path.join(caseDir, 'case.json')} missing or unparsable`);
    process.exit(3);
  }

  const missing = missingDeps(CASE_DEPS[caseId]);
  if (missing.length) {
    console.log(JSON.stringify({ caseId, status: 'blocked_dependency_missing', missing }, null, 2));
    process.exit(2);
  }

  // Fresh, disposable workspace (gitignored).
  const ws = path.join(caseDir, 'workspace');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  const checks = [];
  const notes = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 500) }) });
  const note = (t) => notes.push(t);

  try {
    const ret = await SCENARIOS[caseId]({ ws, check, note });
    if (typeof ret === 'string' && ret.startsWith('blocked')) {
      console.log(JSON.stringify({ caseId, status: 'blocked_dependency_missing', missing: [ret.replace(/^blocked:\s*/, '')] }, null, 2));
      process.exit(2);
    }
  } catch (err) {
    check('scenario ran without crashing', false, `${err.message}\n${(err.stack || '').split('\n').slice(1, 4).join('\n')}`);
  }

  const status = checks.length && checks.every((c) => c.ok) ? 'pass' : 'fail';
  console.log(JSON.stringify({ caseId, title: caseJson.title, status, expectation: caseJson.expectation, checks, notes }, null, 2));
  process.exit(status === 'pass' ? 0 : 1);
}

await main();
