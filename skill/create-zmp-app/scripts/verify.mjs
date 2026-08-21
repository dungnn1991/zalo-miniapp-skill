#!/usr/bin/env node
// verify.mjs — aggregate every stage's evidence into runs/<id>/result.json (Subagent C).
// Full gate list: install_ok, build_ok, build_artifacts, app_id_bound, portal_sources_recorded,
// every browser-runner gate from evidence/gates.json (viewport tags kept), evidence_complete.
// Phase 2 (only when the run has deploy/login evidence or events): deploy_ok,
// deployed_url_recorded, no_token_in_evidence, login_not_scripted; result schemaVersion "1.1".
// Runs without deploy evidence keep the exact Phase 1 behavior (schemaVersion "1.0").
// Every FAILED gate gets a finding (fingerprint-deduped) before the run ends — no silent reds.
// Exit codes: 0 pass · 1 fail · 2 result was already needs_input (left untouched) · 3 harness error.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';
import { recordFinding } from './record-finding.mjs';
import { EXPECTED_INSTALL, actualInstall } from './install.mjs';
import {
  EXPECTED_BUILD, actualBuild, EXPECTED_ARTIFACTS, EXPECTED_APP_ID, actualAppId,
  classifyBuildFailure, distHasJsAsset,
} from './build.mjs';
import { EXPECTED_DEPLOY, actualDeploy, EXPECTED_DEPLOY_URL } from './deploy.mjs';
import {
  appendPreflight, readSrcTexts, scanPermissionApis, scanCheckoutPolicy, corsPreflightGate,
  EXPECTED_SERVER_SIDE_API, EXPECTED_SIZE_LIMIT, matchSignatures,
} from './insight.mjs';

// Mandatory run evidence per plan §10 (install.log is extra evidence, not mandatory there).
const MANDATORY_EVIDENCE = [
  'input.json',
  'environment.json',
  'portal-sources.json',
  'events.jsonl',
  'evidence/app-id-binding.json',
  'evidence/build.log',
  'evidence/console.jsonl',
  'evidence/dom.json',
  'evidence/mobile-390x844.png',
  'evidence/wide-1280x800.png',
];

// Pipeline order (Phase 2 appends login/deploy after verify).
const STAGE_ORDER = ['input', 'portal', 'scaffold', 'install', 'build', 'render', 'verify', 'login', 'deploy', 'cleanup'];

function readEvents(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function lastExitCode(events, step) {
  let code = null;
  for (const e of events) {
    if (e.step === step && typeof e.exitCode === 'number') code = e.exitCode;
  }
  return code;
}

function portalGate(runDir) {
  const file = path.join(runDir, 'portal-sources.json');
  if (!fs.existsSync(file)) return { status: 'fail', detail: 'portal-sources.json missing' };
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { status: 'fail', detail: 'portal-sources.json unparsable' }; }
  const sources = Array.isArray(data) ? data : Array.isArray(data?.sources) ? data.sources : null;
  if (!sources || sources.length === 0) return { status: 'fail', detail: 'no portal sources recorded' };
  const bad = sources.filter((s) => !s || !s.url || !s.sha256
    || !(s.status === 200 || s.status === '200' || s.status === 'ok' || s.status === 'fetched'));
  return bad.length
    ? { status: 'fail', detail: `${bad.length}/${sources.length} sources not fetched ok` }
    : { status: 'pass', detail: `${sources.length} sources fetched` };
}

// --- Phase 2 gate helpers -------------------------------------------------------------------

function deployJsonGate(runDir) {
  const file = path.join(runDir, 'evidence', 'deploy.json');
  if (!fs.existsSync(file)) return { status: 'fail', detail: 'evidence/deploy.json missing' };
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { status: 'fail', detail: 'evidence/deploy.json unparsable' }; }
  const problems = [];
  for (const k of ['schemaVersion', 'runId', 'mode', 'deployedUrl', 'deployedAt', 'cliVersion']) {
    if (d[k] == null) problems.push(`missing ${k}`);
  }
  if (d.mode != null && !['development', 'testing'].includes(d.mode)) problems.push('bad mode');
  if (typeof d.deployedUrl === 'string') {
    // Real scheme observed 2026-08-20 (deploy-evidence.schema.json): https://zalo.me/s/<appId>/...
    if (!/zalo\.me\/s\//.test(d.deployedUrl)) problems.push('deployedUrl scheme mismatch');
    if (!d.deployedUrl.startsWith('https://')) problems.push('deployedUrl not normalized to https://');
  }
  if (d.qrDecodedUrl != null && d.qrDecodedUrl !== d.deployedUrl) problems.push('qrDecodedUrl does not match deployedUrl');
  return problems.length
    ? { status: 'fail', detail: problems.join('; ') }
    : { status: 'pass', detail: `deployedUrl recorded (${d.mode})` };
}

// Scan every text artifact under runs/<id>/ for token-shaped content. Screenshots (.png)
// skipped. Details name file + pattern only — matched content is NEVER echoed anywhere.
function tokenScanGate(runDir) {
  const jwtRe = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const rawKeyRe = /ZMP_TOKEN=(?!\[REDACTED\])[^\s]/;
  const hits = [];
  const stack = [runDir];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || entry.name.endsWith('.png')) continue;
      const rel = path.relative(runDir, full);
      const text = fs.readFileSync(full, 'utf8');
      const jwts = text.match(jwtRe) || [];
      if (jwts.some((m) => m.length > 40)) hits.push(`${rel} (jwt-shaped)`);
      if (rawKeyRe.test(text)) hits.push(`${rel} (raw token key value)`);
    }
  }
  return hits.length
    ? { status: 'fail', detail: `token-shaped content in: ${hits.join(', ')}` }
    : { status: 'pass', detail: 'no token-shaped content in run artifacts' };
}

function loginNotScriptedGate(events) {
  const offending = events.filter((e) => typeof e.command === 'string'
    && e.command.includes('zmp login') && e.command.includes('--token'));
  return offending.length
    ? { status: 'fail', detail: `${offending.length} event(s) in events.jsonl script zmp login with --token` }
    : { status: 'pass', detail: 'no scripted zmp login with --token in events' };
}

// --------------------------------------------------------------------------------------------

// Which pipeline stage a gate belongs to (drives result.stage = first failing stage).
function gateStage(id) {
  if (id === 'portal_sources_recorded') return 'portal';
  if (id === 'install_ok') return 'install';
  if (id === 'build_ok' || id === 'build_artifacts' || id === 'app_id_bound'
    || id === 'size_limit' || id === 'asset_path_scan' || id === 'server_side_api_scan') return 'build';
  if (id === 'evidence_complete' || id === 'permission_registry_hint'
    || id === 'cors_preflight_probe' || id === 'checkout_sdk_policy_hint') return 'verify';
  if (id === 'login_not_scripted' || id === 'zmp_token_env_override_hint') return 'login';
  if (id === 'deploy_ok' || id === 'deployed_url_recorded' || id === 'no_token_in_evidence') return 'deploy';
  return 'render'; // browser-runner gates
}

// Finding parameters per failed gate. Render-gate expected texts are stable invariants;
// numbers/viewports live in `actual` (fingerprint keeps them, per locked normalization).
function findingForGate(g, aux) {
  const stage = gateStage(g.id);
  const renderEvidence = ['evidence/gates.json', 'evidence/dom.json', 'evidence/console.jsonl'];
  const at = g.viewport ? ` at ${g.viewport}` : '';
  switch (true) {
    case g.id === 'portal_sources_recorded':
      return { stage, category: 'harness', severity: 'major',
        expected: 'portal-sources.json records all fetched Portal docs with sha256 and ok status',
        actual: g.detail, evidence: ['portal-sources.json'] };
    case g.id === 'install_ok':
      return { stage, category: 'dependency', severity: 'blocking',
        expected: EXPECTED_INSTALL,
        actual: aux.installExit === null ? 'install stage never ran' : actualInstall(aux.installExit),
        evidence: ['evidence/install.log'] };
    case g.id === 'build_ok':
      return { stage, category: aux.buildFailCategory, severity: 'blocking',
        expected: EXPECTED_BUILD,
        actual: aux.buildExit === null ? 'build stage never ran' : actualBuild(aux.buildExit),
        evidence: ['evidence/build.log'] };
    case g.id === 'build_artifacts':
      return { stage, category: 'app', severity: 'blocking',
        expected: EXPECTED_ARTIFACTS, actual: g.detail, evidence: ['evidence/build.log'] };
    case g.id === 'app_id_bound':
      return { stage, category: 'skill', severity: 'blocking',
        expected: EXPECTED_APP_ID, actual: g.detail, evidence: ['evidence/app-id-binding.json'] };
    case g.id === 'react_mount':
      return { stage, category: 'template', severity: 'blocking',
        expected: 'react mounts the app-root marker within 15s',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id.startsWith('marker_'):
      return { stage, category: 'template', severity: 'major',
        expected: `marker ${g.id.slice('marker_'.length)} present with non-zero size`,
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'no_horizontal_overflow':
      // Negative control `responsive_overflow` greps for this exact phrase.
      return { stage, category: 'app', severity: 'major',
        expected: 'no horizontal overflow (scrollWidth <= innerWidth + 1)',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'cta_not_clipped':
      return { stage, category: 'app', severity: 'major',
        expected: 'primary CTA fully inside viewport width',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'interaction_add_to_cart':
      return { stage, category: 'app', severity: 'major',
        expected: 'clicking add-to-cart increments cart-badge by exactly 1',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'screenshot':
      return { stage, category: 'harness', severity: 'major',
        expected: 'screenshot evidence written per viewport',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'no_fatal_console_error':
      return { stage, category: 'app', severity: 'major',
        expected: 'no fatal console errors or uncaught page errors',
        actual: `${g.detail}${at}`, evidence: renderEvidence };
    case g.id === 'evidence_complete':
      return { stage, category: 'harness', severity: 'major',
        expected: 'all mandatory run evidence artifacts exist (plan §10)',
        actual: g.detail, evidence: ['events.jsonl'] };
    case g.id === 'size_limit':
      return { stage, category: 'app', severity: 'blocking',
        expected: EXPECTED_SIZE_LIMIT, actual: g.detail, evidence: ['evidence/preflight.json'] };
    case g.id === 'server_side_api_scan':
      return { stage, category: 'app', severity: 'blocking',
        expected: EXPECTED_SERVER_SIDE_API, actual: g.detail, evidence: ['evidence/preflight.json'] };
    case g.id === 'deploy_ok':
      return { stage, category: 'dependency', severity: 'blocking',
        expected: EXPECTED_DEPLOY,
        actual: aux.deployExit === null ? 'no deploy event recorded' : actualDeploy(aux.deployExit),
        evidence: ['evidence/deploy.log'] };
    case g.id === 'deployed_url_recorded':
      return { stage, category: 'dependency', severity: 'major',
        expected: EXPECTED_DEPLOY_URL, actual: g.detail, evidence: ['evidence/deploy.log'] };
    case g.id === 'no_token_in_evidence':
      return { stage, category: 'harness', severity: 'blocking',
        expected: 'no token-shaped content in any run artifact (redaction pipeline holds)',
        actual: g.detail, evidence: ['events.jsonl'] };
    case g.id === 'no_unmocked_silent_success':
      return { stage, category: 'harness', severity: 'blocking',
        expected: 'every unmocked simulator bridge call fails loudly with a non-zero error_code',
        actual: g.detail, evidence: ['evidence/bridge-log.jsonl'] };
    case g.id === 'login_not_scripted':
      return { stage, category: 'skill', severity: 'blocking',
        expected: 'agent never scripts zmp login with a token argument (token custody stays with zmp-cli)',
        actual: g.detail, evidence: ['events.jsonl'] };
    default:
      return { stage, category: 'harness', severity: 'major',
        expected: `gate ${g.id} passes`, actual: `${g.detail}${at}`, evidence: renderEvidence };
  }
}

// Hand-rolled result.schema.json validation — an invalid result.json must be impossible.
export function validateResult(r) {
  const errs = [];
  const allowedKeys = new Set(['schemaVersion', 'runId', 'status', 'stage', 'provider', 'needsInput',
    'appIdSource', 'expectedAppId', 'resolvedAppId', 'appIdBound', 'gates', 'findingIds', 'insights', 'startedAt', 'finishedAt']);
  for (const k of Object.keys(r)) if (!allowedKeys.has(k)) errs.push(`unexpected key ${k}`);
  if (!['1.0', '1.1'].includes(r.schemaVersion)) errs.push(`schemaVersion must be "1.0" or "1.1", got ${r.schemaVersion}`);
  if (!/^run-[0-9TZ-]+-[a-z0-9]{4}$/.test(r.runId || '')) errs.push(`runId pattern mismatch: ${r.runId}`);
  if (!['pass', 'fail', 'needs_input'].includes(r.status)) errs.push(`bad status ${r.status}`);
  if (![...STAGE_ORDER, 'done'].includes(r.stage)) errs.push(`bad stage ${r.stage}`);
  if (!['browser', 'simulator'].includes(r.provider)) errs.push(`bad provider ${r.provider}`);
  if (!(r.appIdSource === null || ['prompt', 'existing_project'].includes(r.appIdSource))) errs.push(`bad appIdSource ${r.appIdSource}`);
  if (!(r.expectedAppId === null || typeof r.expectedAppId === 'string')) errs.push('bad expectedAppId');
  if (!(r.resolvedAppId === null || typeof r.resolvedAppId === 'string')) errs.push('bad resolvedAppId');
  if (typeof r.appIdBound !== 'boolean') errs.push('appIdBound must be boolean');
  if (!Array.isArray(r.gates)) errs.push('gates must be array');
  else for (const g of r.gates) {
    if (typeof g.id !== 'string' || !['pass', 'fail', 'warn', 'skipped'].includes(g.status)) errs.push(`bad gate ${JSON.stringify(g)}`);
    for (const k of Object.keys(g)) if (!['id', 'status', 'detail', 'viewport'].includes(k)) errs.push(`gate ${g.id}: unexpected key ${k}`);
  }
  if (!Array.isArray(r.findingIds) || r.findingIds.some((f) => typeof f !== 'string')) errs.push('findingIds must be string array');
  if (r.insights !== undefined) {
    if (!Array.isArray(r.insights)) errs.push('insights must be array');
    else for (const ins of r.insights) {
      if (typeof ins.id !== 'string' || !['gate', 'signature'].includes(ins.kind)
        || typeof ins.diagnosis !== 'string' || typeof ins.fix !== 'string') errs.push(`bad insight ${JSON.stringify(ins).slice(0, 100)}`);
      for (const k of Object.keys(ins)) if (!['id', 'kind', 'diagnosis', 'fix', 'source'].includes(k)) errs.push(`insight ${ins.id}: unexpected key ${k}`);
    }
  }
  for (const k of ['startedAt', 'finishedAt']) {
    if (Number.isNaN(Date.parse(r[k]))) errs.push(`${k} not a date-time`);
  }
  return errs;
}

async function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  if (!runId) {
    console.error('verify: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`verify: run dir not found: ${runDir}`);
    process.exit(3);
  }
  const ctx = openRun(ws.runsDir, runId);

  // A needs_input result written by bootstrap/ensure-login is final for that run — leave untouched.
  const existing = ctx.readJson('result.json');
  if (existing && existing.status === 'needs_input') {
    console.log(JSON.stringify({ runId, status: 'needs_input', note: 'result.json left untouched by verify' }));
    process.exit(2);
  }

  ctx.event('verify', { stage: 'verify', status: 'start' });

  const events = readEvents(runDir);
  const input = ctx.readJson('input.json');
  const binding = ctx.readJson('evidence/app-id-binding.json');
  const runnerGates = ctx.readJson('evidence/gates.json');

  // Phase 2/3 detection. hasDeploy drives the four deploy gates; a simulator bridge-log only
  // adds its own gate. Either flips schemaVersion to 1.1; plain runs stay 1.0 bit-for-bit.
  const bridgeLogPath = path.join(runDir, 'evidence', 'bridge-log.jsonl');
  const hasBridgeLog = fs.existsSync(bridgeLogPath);
  const hasDeploy = fs.existsSync(path.join(runDir, 'evidence', 'deploy.log'))
    || events.some((e) => e.step === 'deploy' || e.step === 'ensure-login' || e.step === 'login'
      || (typeof e.command === 'string' && e.command.includes('zmp ')));
  const isPhase2 = hasDeploy || hasBridgeLog;

  const gates = [];
  const aux = {
    installExit: lastExitCode(events, 'install'),
    buildExit: lastExitCode(events, 'build'),
    deployExit: lastExitCode(events, 'deploy'),
    buildFailCategory: 'app',
  };
  try {
    aux.buildFailCategory = classifyBuildFailure(fs.readFileSync(path.join(runDir, 'evidence', 'build.log'), 'utf8'));
  } catch { /* no build log yet — default 'app' */ }

  // 1. portal
  const p = portalGate(runDir);
  gates.push({ id: 'portal_sources_recorded', status: p.status, detail: p.detail });

  // 2. install
  gates.push({
    id: 'install_ok',
    status: aux.installExit === 0 ? 'pass' : 'fail',
    detail: aux.installExit === null ? 'no install event recorded' : `pnpm install exit ${aux.installExit}`,
  });

  // 3. build + artifacts + app id binding
  gates.push({
    id: 'build_ok',
    status: aux.buildExit === 0 ? 'pass' : 'fail',
    detail: aux.buildExit === null ? 'no build event recorded' : `vite build exit ${aux.buildExit}`,
  });
  {
    // Phase 2.5: check the outDir the build recorded (official templates may emit www);
    // fallback "dist" keeps pre-build-info runs working.
    const outDir = ctx.readJson('evidence/build-info.json')?.outDir ?? 'dist';
    const distDir = path.join(ws.appDir, outDir);
    const missing = [];
    if (!fs.existsSync(path.join(distDir, 'index.html'))) missing.push(`${outDir}/index.html`);
    if (!distHasJsAsset(distDir)) missing.push(`${outDir}/**/*.js`);
    gates.push({
      id: 'build_artifacts',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length ? `missing: ${missing.join(', ')}` : `${outDir}/index.html + js asset present`,
    });
  }
  {
    const bound = !!binding && binding.exactMatch === true
      && typeof binding.buildProcessAppId === 'string'
      && binding.buildProcessAppId === binding.expectedAppId;
    gates.push({
      id: 'app_id_bound',
      status: bound ? 'pass' : 'fail',
      detail: binding
        ? actualAppId(binding.expectedAppId, binding.buildProcessAppId ?? null) + ` exactMatch=${binding.exactMatch}`
        : 'evidence/app-id-binding.json missing',
    });
  }

  // 4. browser runner gates — verbatim, viewport tags kept
  if (runnerGates && Array.isArray(runnerGates.gates)) {
    for (const g of runnerGates.gates) {
      gates.push({ id: g.id, status: g.status, detail: g.detail ?? '', ...(g.viewport ? { viewport: g.viewport } : {}) });
    }
  } else {
    gates.push({ id: 'react_mount', status: 'fail', detail: 'evidence/gates.json missing — render stage never ran' });
  }

  // 5. evidence completeness
  {
    const missing = MANDATORY_EVIDENCE.filter((rel) => !fs.existsSync(path.join(runDir, rel)));
    gates.push({
      id: 'evidence_complete',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length ? `missing: ${missing.join(', ')}` : `${MANDATORY_EVIDENCE.length} mandatory artifacts present`,
    });
  }

  // 5b. Phase 2.6 Tier-1 (plan 29 §2.1): verify-stage scans + every preflight gate recorded
  // by earlier stages (build/ensure-login/deploy) folded into result.gates. warn ≠ fail.
  const insights = [];
  const srcTexts = readSrcTexts(ws.appDir);
  appendPreflight(ctx, scanPermissionApis(srcTexts));
  appendPreflight(ctx, scanCheckoutPolicy(srcTexts));
  appendPreflight(ctx, await corsPreflightGate(srcTexts));
  const preflightAll = ctx.readJson('evidence/preflight.json')?.gates ?? [];
  const preflightById = new Map(preflightAll.map((p) => [p.id, p]));
  for (const g of preflightAll) {
    gates.push({ id: g.id, status: g.status, detail: g.detail ?? '' });
    if (g.insight && (g.status === 'warn' || g.status === 'fail')) {
      insights.push({ id: g.id, kind: 'gate', diagnosis: g.insight.diagnosis, fix: g.insight.fix, source: g.insight.source ?? null });
    }
  }

  // 6. Phase 2 deploy gates (opt-in, plan 27 §3.3) — only for runs that actually deployed
  if (hasDeploy) {
    gates.push({
      id: 'deploy_ok',
      status: aux.deployExit === 0 ? 'pass' : 'fail',
      detail: aux.deployExit === null ? 'no deploy event recorded' : `zmp deploy exit ${aux.deployExit}`,
    });
    const dj = deployJsonGate(runDir);
    gates.push({ id: 'deployed_url_recorded', status: dj.status, detail: dj.detail });
    const ts = tokenScanGate(runDir);
    gates.push({ id: 'no_token_in_evidence', status: ts.status, detail: ts.detail });
    const ln = loginNotScriptedGate(events);
    gates.push({ id: 'login_not_scripted', status: ln.status, detail: ln.detail });
  }

  // 7. Phase 3 simulator gate (plan 28): every unmocked bridge call must have failed loudly —
  // a mock host that silently succeeds on unknown APIs would fake confidence.
  if (hasBridgeLog) {
    const entries = fs.readFileSync(bridgeLogPath, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const silent = entries.filter((e) => e.unmocked && !(typeof e.error_code === 'number' && e.error_code !== 0));
    gates.push({
      id: 'no_unmocked_silent_success',
      status: silent.length ? 'fail' : 'pass',
      detail: silent.length
        ? `${silent.length} unmocked bridge entr${silent.length === 1 ? 'y' : 'ies'} without non-zero error_code`
        : `${entries.length} bridge entries; every unmocked call failed loudly`,
    });
  }

  // Every failed gate must have a finding before the run ends. Tier-2: when the stage log
  // matches the curated error-signature map, attach the diagnosis to finding + insights.
  const sigTextFor = (gateId) => {
    const stage = gateStage(gateId);
    const file = stage === 'build' ? 'evidence/build.log'
      : stage === 'deploy' ? 'evidence/deploy.log'
        : stage === 'render' ? 'evidence/console.jsonl' : null;
    if (!file) return { text: null, stage };
    try { return { text: fs.readFileSync(path.join(runDir, file), 'utf8'), stage }; } catch { return { text: null, stage }; }
  };
  const findingIds = new Set(events.filter((e) => e.findingId).map((e) => e.findingId));
  let firstFailStageIdx = Infinity;
  for (const g of gates) {
    if (g.status !== 'fail') continue;
    firstFailStageIdx = Math.min(firstFailStageIdx, STAGE_ORDER.indexOf(gateStage(g.id)));
    const spec = findingForGate(g, aux);
    const { text, stage: sigStage } = sigTextFor(g.id);
    const sig = text ? (matchSignatures(text, sigStage)[0] ?? null) : null;
    if (sig) {
      spec.insight = { diagnosis: sig.diagnosis, fix: sig.fix, source: sig.source ?? null };
      insights.push({ id: sig.id, kind: 'signature', diagnosis: sig.diagnosis, fix: sig.fix, source: sig.source ?? null });
    } else if (preflightById.get(g.id)?.insight) {
      spec.insight = preflightById.get(g.id).insight;
    }
    const finding = recordFinding({ workspace: ws.root, runId, runDir, ...spec });
    findingIds.add(finding.findingId);
  }
  // Dedupe insights (a signature can match several failed gates of the same stage).
  const insightsOut = [...new Map(insights.map((i) => [`${i.kind}:${i.id}`, i])).values()];

  const failed = gates.filter((g) => g.status === 'fail');
  const status = failed.length === 0 ? 'pass' : 'fail';
  const result = {
    schemaVersion: isPhase2 ? '1.1' : '1.0',
    runId,
    status,
    stage: status === 'pass' ? 'done' : STAGE_ORDER[firstFailStageIdx],
    provider: input?.renderProvider ?? 'browser',
    appIdSource: input?.appIdSource ?? binding?.sourceType ?? null,
    expectedAppId: binding?.expectedAppId ?? null,
    resolvedAppId: binding?.persistedAppId ?? null,
    appIdBound: gates.find((g) => g.id === 'app_id_bound')?.status === 'pass',
    gates,
    findingIds: [...findingIds],
    ...(insightsOut.length ? { insights: insightsOut } : {}),
    startedAt: events[0]?.at ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };

  const errs = validateResult(result);
  if (errs.length) {
    console.error(`verify: result.json would violate result.schema.json — refusing to write:\n  ${errs.join('\n  ')}`);
    process.exit(3);
  }
  ctx.writeJson('result.json', result);
  ctx.event('verify', { stage: 'verify', status, exitCode: status === 'pass' ? 0 : 1 });

  console.log(JSON.stringify({ runId, status, stage: result.stage, failedGates: failed.map((g) => g.id + (g.viewport ? `@${g.viewport}` : '')), findingIds: result.findingIds }));
  process.exit(status === 'pass' ? 0 : 1);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) await main();
