#!/usr/bin/env node
// run.mjs — SINGLE ENTRY for the whole create-zmp-app pipeline (Subagent C, plan 29 §3.2).
//
//   node scripts/run.mjs --brief "..." [--app-id X] [--confirm-app-id X] [--app-name N]
//        [--template official:<id>] [--capability checkout]
//        [--checkout-mode simulator|demo-cod]
//        [--existing | --force-scaffold] [--invoked-via S]
//        [--deploy] [--deploy-testing] [--desc "..."] [--preview] [--preview-timeout <ms>]
//        [--workspace W]
//
// Chains: bootstrap → portal-fetch → install → build → render → verify
//         [--deploy/--deploy-testing: → ensure-login → deploy → verify]
//         [--preview: → preview.mjs last, even without deploy]
// Each stage runs as a CHILD PROCESS (exit-code contract preserved). Any stage exiting non-0
// stops the chain immediately: run.mjs exits with the same code and prints one final JSON
// merging that stage's own JSON (bootstrap needs_input/conflict/needs_template_choice is
// forwarded verbatim so the host agent can ask the user). Full pass prints
// {runId, status: "pass", deployedUrl?, insights, resultPath}.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace, getArg, SKILL_DIR } from './lib/paths.mjs';
import { doctorVersionLine } from './lib/version.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ws = resolveWorkspace(argv);
const workspaceArg = getArg(argv, 'workspace') ? ['--workspace', ws.root] : [];

// Pass-through of bootstrap's own flags.
const bootstrapArgs = [];
for (const flag of ['brief', 'app-id', 'confirm-app-id', 'app-name', 'template', 'capability', 'checkout-mode', 'invoked-via']) {
  const v = getArg(argv, flag);
  if (v !== null) bootstrapArgs.push(`--${flag}`, v);
}
// Boolean safe-rerun flags (no value): --existing = verify/build the app already in the
// workspace; --force-scaffold = user-authorized overwrite of a modified app.
for (const flag of ['existing', 'force-scaffold']) {
  if (argv.includes(`--${flag}`)) bootstrapArgs.push(`--${flag}`);
}
const wantDeploy = argv.includes('--deploy') || argv.includes('--deploy-testing');
const deployTesting = argv.includes('--deploy-testing');
const wantPreview = argv.includes('--preview');
const wantPreviewSim = argv.includes('--preview-sim');
const verifySim = argv.includes('--verify-sim');
const simDecision = getArg(argv, 'sim-decision', 'accept');
const checkoutResult = getArg(argv, 'checkout-result', 'success');
if (!['success', 'pending', 'fail', 'cancel'].includes(checkoutResult)) {
  console.error(`run: unknown --checkout-result "${checkoutResult}" (success|pending|fail|cancel)`);
  process.exit(3);
}
const desc = getArg(argv, 'desc');

// ---- doctor: prerequisites, before any stage in any mode (user's machine may be fresh) ----
function doctor({ needZmp }) {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 20) {
    console.error(`doctor: Node >= 20 required, found ${process.versions.node} — install a newer Node and retry`);
    process.exit(3);
  }
  const missingDeps = ['playwright-core', 'jsqr']
    .filter((d) => !fs.existsSync(path.join(SKILL_DIR, 'node_modules', d)));
  if (missingDeps.length) {
    console.error(`doctor: first-run setup — installing package deps (${missingDeps.join(', ')}) in ${SKILL_DIR} ...`);
    let r = spawnSync('pnpm', ['install'], { cwd: SKILL_DIR, encoding: 'utf8' });
    if (r.error) r = spawnSync('npm', ['install'], { cwd: SKILL_DIR, encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      console.error('doctor: dependency install failed — run `pnpm install` (or `npm install`) inside the skill folder, then retry:');
      console.error(`  ${SKILL_DIR}`);
      console.error(String(r.stderr || r.error?.message || '').slice(-400));
      process.exit(3);
    }
  }
  const chromeOk = process.platform === 'darwin'
    ? (fs.existsSync('/Applications/Google Chrome.app')
      || fs.existsSync(path.join(process.env.HOME ?? '/', 'Applications', 'Google Chrome.app')))
    : ['google-chrome', 'chromium-browser', 'chromium']
      .some((b) => spawnSync('which', [b], { encoding: 'utf8' }).status === 0);
  if (!chromeOk) {
    console.error('doctor: cần Google Chrome cho render/simulator (playwright channel chrome) — cài Chrome rồi chạy lại');
    process.exit(3);
  }
  if (needZmp) {
    // Some zmp-cli versions touch an empty .env in their cwd even for --version. Probe in a
    // private temp directory so a deploy preflight can never pollute the skill or user repo.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmp-doctor-'));
    let z;
    try {
      z = spawnSync('zmp', ['--version'], { cwd: probeDir, encoding: 'utf8' });
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
    if (z.error) {
      console.error('doctor: deploy cần zmp-cli — cài bằng `npm i -g zmp-cli` rồi chạy lại');
      process.exit(3);
    }
  }
  // Version provenance must remain useful on both supported install paths: install.sh
  // stamps an immutable ref; Claude's plugin cache carries the matching plugin manifest.
  console.error(doctorVersionLine(SKILL_DIR));
}
if (!argv.includes('--skip-doctor')) doctor({ needZmp: wantDeploy });

function runStage(name, args) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, `${name}.mjs`), ...args, ...workspaceArg], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = res.stdout || '';
  const lines = stdout.split('\n');
  let lastJson = null;
  let lastJsonIdx = -1;
  for (let i = lines.length - 1; i >= 0 && !lastJson; i--) {
    if (!lines[i].trim()) continue;
    try { lastJson = JSON.parse(lines[i]); lastJsonIdx = i; } catch { /* not json */ }
  }
  // Relay stage stdout exactly ONCE (finding_5efb3e8e6a00): the stage's final JSON line is
  // represented by run.mjs's own final JSON (stopAt merge / pass summary), so it is NOT
  // echoed here — only any other stage output stays visible.
  const relay = lines.filter((_, i) => i !== lastJsonIdx).join('\n').trimEnd();
  if (relay.trim()) process.stdout.write(relay + '\n');
  return { code: res.status ?? 3, lastJson };
}

function stopAt(stage, code, stageJson, runId) {
  // Forward the stage's own JSON verbatim (needs_input question, conflict ids, ...).
  console.log(JSON.stringify({ runId: runId ?? stageJson?.runId ?? null, stoppedAt: stage, exitCode: code, ...stageJson }));
  process.exit(code);
}

// 1. bootstrap — the only stage with its own arg surface; it mints the runId.
const boot = runStage('bootstrap', bootstrapArgs);
const runId = boot.lastJson?.runId ?? null;
if (boot.code !== 0 || boot.lastJson?.status !== 'ok') stopAt('bootstrap', boot.code, boot.lastJson, runId);

// 2..6 fixed chain. --verify-sim switches render to the simulator provider (plan 28).
for (const stage of ['portal-fetch', 'install', 'build', 'render', 'verify']) {
  const args = ['--run-id', runId];
  if (stage === 'render') {
    if (verifySim) args.push('--provider', 'simulator');
    if (getArg(argv, 'sim-decision') !== null) args.push('--sim-decision', simDecision);
    if (getArg(argv, 'checkout-result') !== null) args.push('--checkout-result', checkoutResult);
  }
  const r = runStage(stage, args);
  if (r.code !== 0) stopAt(stage, r.code, r.lastJson, runId);
}

// 7. opt-in deploy path (explicit user request only) + re-verify with deploy gates.
if (wantDeploy) {
  let runInput = null;
  let verifiedResult = null;
  try { runInput = JSON.parse(fs.readFileSync(path.join(ws.runsDir, runId, 'input.json'), 'utf8')); } catch { /* deploy.mjs will report malformed runs */ }
  try { verifiedResult = JSON.parse(fs.readFileSync(path.join(ws.runsDir, runId, 'result.json'), 'utf8')); } catch { /* deploy.mjs will report malformed runs */ }
  const checkoutMode = runInput?.checkoutMode ?? 'simulator';
  if (runInput?.capabilities?.includes('checkout') && (checkoutMode !== 'demo-cod' || deployTesting)) {
    stopAt('deploy', 3, {
      status: 'blocked',
      code: deployTesting && checkoutMode === 'demo-cod'
        ? 'CHECKOUT_DEMO_DEVELOPMENT_ONLY'
        : 'CHECKOUT_FIXTURE_NONDEPLOYABLE',
      message: deployTesting && checkoutMode === 'demo-cod'
        ? 'The client-only COD demo is qualified for the replaceable Development slot only, not Testing or production-like claims.'
        : 'Checkout simulator mode has no deployable merchant boundary. Use --checkout-mode demo-cod for a visibly labelled Development UI demo, or add the real backend from references/checkout-backend.md.',
      ...(verifiedResult?.warnings?.length ? { warnings: verifiedResult.warnings } : {}),
    }, runId);
  }
  const login = runStage('ensure-login', ['--run-id', runId]);
  if (login.code !== 0) stopAt('ensure-login', login.code, login.lastJson, runId);
  const deployArgs = ['--run-id', runId];
  if (deployTesting) deployArgs.push('--testing');
  if (desc !== null) deployArgs.push('--desc', desc);
  const dep = runStage('deploy', deployArgs);
  if (dep.code !== 0) stopAt('deploy', dep.code, dep.lastJson, runId);
  const reverify = runStage('verify', ['--run-id', runId]);
  if (reverify.code !== 0) stopAt('verify', reverify.code, reverify.lastJson, runId);
}

// Final JSON for the host agent.
const runDir = path.join(ws.runsDir, runId);
const resultPath = path.join(runDir, 'result.json');
let result = null;
try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { /* validated by verify */ }
let deployedUrl;
try { deployedUrl = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence', 'deploy.json'), 'utf8')).deployedUrl; } catch { /* no deploy */ }
// Structured adapter warnings ride all the way out. `insights` is a COUNT because insights are
// about this run and the host agent can read them from resultPath; a warning is different — it
// says the app that was just built is missing something before production (today:
// PHONE_BACKEND_REQUIRED on zaui-lucky-wheel). Emitting only a count let the host agent finish
// with "done, 0 insights" and never mention it, so the whole warning contract died at the last
// hop. The array is emitted verbatim; SKILL.md requires the final report to repeat it.
const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
console.log(JSON.stringify({
  runId,
  status: 'pass',
  ...(deployedUrl ? { deployedUrl } : {}),
  insights: result?.insights?.length ?? 0,
  ...(warnings.length ? { warnings } : {}),
  resultPath,
}));

// 8. optional human preview — blocks until Ctrl+C (JSON above already printed), or until
// --preview-timeout <ms> for scripted/agent use (forwarded as preview.mjs --timeout).
// --preview-sim opens the headed simulator window instead of the plain static preview.
if (wantPreview || wantPreviewSim) {
  const previewArgs = ['--run-id', runId, ...workspaceArg];
  const previewTimeout = getArg(argv, 'preview-timeout');
  if (previewTimeout !== null) previewArgs.push('--timeout', previewTimeout);
  if (wantPreviewSim) {
    previewArgs.push('--sim');
    if (getArg(argv, 'sim-decision') !== null) previewArgs.push('--sim-decision', simDecision);
  }
  if (getArg(argv, 'checkout-result') !== null) previewArgs.push('--checkout-result', checkoutResult);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'preview.mjs'), ...previewArgs], {
    stdio: 'inherit',
  });
  process.exit(res.status ?? 0);
}
process.exit(0);
