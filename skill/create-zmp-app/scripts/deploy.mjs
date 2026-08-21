#!/usr/bin/env node
// deploy.mjs — Phase 2 deploy provider (Subagent C).
//
//   node deploy.mjs --run-id <id> [--testing] [--desc "<text>"] [--workspace <dir>]
//
// Command + flags come from lab.config.json zmpCli.deploy (developmentCommand, testingExtraFlag);
// -m description = --desc value, defaulting to `test <YYYY-MM-DD HH:mm UTC> (<runId>)` —
// user-facing in Quản lý phiên bản (mainly Testing), runId kept for traceability.
// Spawn cwd = app/ with inherited env (env is NEVER printed or logged).
// Output is ANSI-stripped + redacted into evidence/deploy.log.
//
// Pipeline (after preconditions + token-key check, so needs_login spawns NOTHING):
//   zmp sync-config <outDir>/index.html — populates app-config.json asset lists for existing-
//                                         project deploys (finding_1d573da3fa61); FILE argument,
//                                         a directory crashes zmp-cli with EISDIR
//   zmp deploy -p -e -o <outDir> -m <desc>   (outDir from evidence/build-info.json, fallback dist)
//
// Classification (README Phase 2 contract):
//   authFailureMessage (-2001) → needs_input/login_required, exit 2 (token missing/expired)
//   other failure → finding stage deploy, exit 1
//   success → deployed URL: text parse (zalo.me/s/) or decode the terminal QR printed after
//     "View app at:" with jsqr — CLI 4.0.3 prints the URL only as a QR
//     (finding_42bccd1d5f27; lab.config.json zmpCli.deployOutputIsQrOnly) → evidence/deploy.json
//   success without parseable URL → finding deploy_output_unparseable, exit 1
// Exit 3: precondition/config error (missing run/args, zmp binary absent).
// Also importable (main-guarded): verify.mjs reuses the finding texts; the deploy-qr-parse
// case exercises the parsers against a real captured deploy.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveWorkspace, getArg, loadLabConfig, LAB_ROOT } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';
import { recordFinding } from './record-finding.mjs';
import { tokenKeyExists, upsertLoginRequired } from './ensure-login.mjs';
import { appendPreflight, scanZmpTokenEnvOverride, matchSignatures } from './insight.mjs';

// Shared finding texts — verify.mjs reconstructs the same strings so fingerprints merge.
export const EXPECTED_DEPLOY = 'zmp deploy exits 0 in passive mode';
export const actualDeploy = (code) => `zmp deploy exited ${code}`;
export const EXPECTED_DEPLOY_URL =
  'zmp deploy output yields deployed URL with scheme zalo.me/s/ via text or QR decode (deploy_output_unparseable)';
export const EXPECTED_SYNC_CONFIG =
  'zmp sync-config populates app-config.json asset lists before existing-project deploy';
export const actualSyncConfig = (code) => `zmp sync-config exited ${code}`;

// Strip CSI (covers the \x1b[2J\x1b[0f clear-screen zmp banner) + OSC escape sequences.
export function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

// Deployed URL as TEXT (future-proofing — CLI 4.0.3 prints QR only): may appear as
// https://..., //..., or bare zalo.me/s/... — normalize to https://.
export function parseDeployedUrl(text) {
  const m = String(text).match(/(?:https?:)?\/\/zalo\.me\/s\/[^\s"'<>)\]]+|(?<![\w./])zalo\.me\/s\/[^\s"'<>)\]]+/);
  if (!m) return null;
  let url = m[0].replace(/[.,;]+$/, '');
  if (url.startsWith('//')) url = `https:${url}`;
  else if (!url.startsWith('http')) url = `https://${url}`;
  return url;
}

// The QR block printed IMMEDIATELY after "View app at:" (never a later block, so a login QR
// can't be picked up by mistake): contiguous lines of only half-block chars/spaces, length
// ≥20, at least 10 lines. Blank lines between anchor and block are allowed.
const QR_CHARS = new Set(['▀', '▄', '█', ' ']);
function extractQrBlockAfterAnchor(lines, anchorRe) {
  const anchorIdx = lines.findIndex((l) => anchorRe.test(l));
  if (anchorIdx < 0) return null;
  let j = anchorIdx + 1;
  while (j < lines.length && lines[j].trim() === '') j++;
  const block = [];
  for (; j < lines.length; j++) {
    const t = lines[j].replace(/\s+$/, '');
    if (t.length >= 20 && [...t].every((c) => QR_CHARS.has(c))) block.push(t);
    else break;
  }
  return block.length >= 10 ? block : null;
}

// Decode the unicode half-block QR with jsqr: each char row carries 2 module rows
// (▀ upper / ▄ lower / █ both), rendered at scale 8 with a 4-module quiet zone, both
// polarities tried. jsqr resolves module-relative (walks up to the nearest node_modules:
// this script lives under skill/, outside normal ESM resolution of the lab root.
export function decodeQrFromOutput(text) {
  let jsQR;
  try {
    jsQR = createRequire(import.meta.url)('jsqr');
  } catch {
    return null; // jsqr unavailable — text parse may still succeed
  }
  const block = extractQrBlockAfterAnchor(String(text).split('\n'), /View app at:/);
  if (!block) return null;
  const width = Math.max(...block.map((l) => l.length));
  const modules = [];
  for (const line of block) {
    const up = [];
    const lo = [];
    for (let x = 0; x < width; x++) {
      const c = line[x] ?? ' ';
      up.push(c === '█' || c === '▀' ? 1 : 0);
      lo.push(c === '█' || c === '▄' ? 1 : 0);
    }
    modules.push(up, lo);
  }
  const tryDecode = (invert) => {
    const scale = 8;
    const margin = 4 * scale;
    const w = width * scale + margin * 2;
    const h = modules.length * scale + margin * 2;
    const data = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let my = 0; my < modules.length; my++) {
      for (let mx = 0; mx < width; mx++) {
        const dark = invert ? modules[my][mx] === 0 : modules[my][mx] === 1;
        if (!dark) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const i = ((my * scale + dy + margin) * w + (mx * scale + dx + margin)) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
        }
      }
    }
    return jsQR(data, w, h);
  };
  for (const invert of [false, true]) {
    const r = tryDecode(invert);
    if (r?.data) return r.data;
  }
  return null;
}

// Deploy version label = the LAST "Version: <label>" AFTER "Deploy Done" (e.g. zdev-dc3f8ce8,
// present for development AND testing). The zmp banner prints "Version: <cliVersion>" BEFORE
// the QR — position separates them, not value comparison.
export function parseVersionLabel(text) {
  const s = String(text);
  const doneIdx = s.search(/Deploy Done/i);
  if (doneIdx < 0) return null;
  const matches = [...s.slice(doneIdx).matchAll(/Version:\s*(\S+)/gi)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

function zmpCliVersion(zc, deployOutput) {
  const probe = spawnSync(zc.binary ?? 'zmp', ['--version'], { encoding: 'utf8' });
  const fromProbe = stripAnsi(`${probe.stdout || ''}${probe.stderr || ''}`).match(/(\d+\.\d+\.\d+)/)?.[1];
  if (fromProbe) return fromProbe;
  return stripAnsi(deployOutput).match(/zmp[- ]?cli[^\d]*(\d+\.\d+\.\d+)/i)?.[1] ?? 'unknown';
}

function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  const testing = argv.includes('--testing');
  if (!runId) {
    console.error('deploy: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`deploy: run dir not found: ${runDir}`);
    process.exit(3);
  }

  const cfg = loadLabConfig();
  const zc = cfg.zmpCli;
  if (!zc?.deploy?.developmentCommand) {
    console.error('deploy: lab.config.json has no zmpCli.deploy.developmentCommand');
    process.exit(3);
  }
  const ctx = openRun(ws.runsDir, runId);

  // Phase 2.6 (FAQ 16): ZMP_TOKEN in the process env overrides app/.env — warn before deploy.
  const envHint = scanZmpTokenEnvOverride();
  if (envHint.status === 'warn') {
    appendPreflight(ctx, envHint);
    ctx.event('preflight', { stage: 'deploy', gateId: envHint.id, status: 'warn', detail: envHint.detail });
  }

  // Precondition 1: verify must have passed with the App ID bound. Deploy is an outward
  // side-effect — never allowed on an unverified build.
  const result = ctx.readJson('result.json');
  if (!result || result.status !== 'pass' || result.appIdBound !== true) {
    ctx.event('deploy', { stage: 'deploy', status: 'precondition_fail', detail: 'verify not passed' });
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'deploy', category: 'harness', severity: 'blocking',
      expected: 'deploy runs only after verify pass with appIdBound=true',
      actual: `result.json ${result ? `status=${result.status} appIdBound=${result.appIdBound}` : 'missing'}`,
      evidence: ['result.json'],
    });
    console.error(`deploy: blocked — verify has not passed for ${runId} — finding ${finding.findingId}`);
    process.exit(1);
  }

  // Precondition 2: build artifact present (zmp-cli only uploads; the lab builds).
  // Phase 2.5: outDir from build-info.json (official templates may emit www); fallback dist.
  const outDir = ctx.readJson('evidence/build-info.json')?.outDir ?? 'dist';
  if (!fs.existsSync(path.join(ws.appDir, outDir, 'index.html'))) {
    ctx.event('deploy', { stage: 'deploy', status: 'precondition_fail', detail: `app/${outDir}/index.html missing` });
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'deploy', category: 'app', severity: 'blocking',
      expected: 'build outDir index.html exists before deploy (lab builds, zmp-cli uploads)',
      actual: `app/${outDir}/index.html missing`,
      evidence: ['result.json'],
    });
    console.error(`deploy: app/${outDir}/index.html missing — finding ${finding.findingId}`);
    process.exit(1);
  }

  // Precondition 3: login gate (key-existence only) — BEFORE any zmp process is spawned.
  const tokenKey = zc.envKeys?.token ?? 'ZMP_TOKEN';
  if (!tokenKeyExists(ws.appDir, tokenKey)) {
    upsertLoginRequired(ctx, runId);
    ctx.event('deploy', {
      stage: 'deploy',
      status: 'needs_login',
      detail: `${tokenKey} key absent from app/.env — no deploy process spawned`,
    });
    console.log(JSON.stringify({ runId, stage: 'deploy', status: 'needs_input', reason: 'login_required' }));
    process.exit(2);
  }

  // Build the command from the pinned config; -m description = --desc, or the default
  // "test <YYYY-MM-DD HH:mm UTC> (<runId>)" (README contract addendum).
  const stampUtc = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const desc = getArg(argv, 'desc') ?? `test ${stampUtc} UTC (${runId})`;
  const cmd = zc.deploy.developmentCommand.map((part) => (part === '<desc>' ? desc : part));
  const mode = testing ? 'testing' : 'development';
  if (testing) {
    const flag = zc.deploy.testingExtraFlag ?? '-t';
    const pIdx = cmd.indexOf('-p');
    cmd.splice(pIdx >= 0 ? pIdx + 1 : cmd.length, 0, flag);
  }
  // -o follows the detected outDir (config command carries the lab default "dist").
  const oIdx = cmd.indexOf('-o');
  if (oIdx >= 0 && cmd[oIdx + 1]) cmd[oIdx + 1] = outDir;
  const outputDir = outDir;

  // FIX finding_1d573da3fa61: existing-project deploys need app-config.json to declare the
  // built assets — `zmp sync-config <outputDir>/index.html` populates listSyncJS/listCSS and
  // writes dist/inline.js. FILE argument (a directory crashes zmp-cli with EISDIR). Runs
  // AFTER the token check on purpose: needs_login must spawn nothing.
  const binary = zc.binary ?? 'zmp';
  const syncArgs = ['sync-config', `${outputDir}/index.html`];
  const t0s = Date.now();
  ctx.event('sync-config', { stage: 'deploy', status: 'start', command: `${binary} ${syncArgs.join(' ')}` });
  const sres = spawnSync(binary, syncArgs, {
    cwd: ws.appDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env, // inherited for zmp-cli; never printed, never logged
  });
  if (sres.error) {
    console.error(`deploy: cannot spawn ${binary}: ${sres.error.message}`);
    process.exit(3);
  }
  const syncCode = sres.status ?? 1;
  ctx.writeTextEvidence('evidence/sync-config.log', stripAnsi(`${sres.stdout || ''}\n${sres.stderr || ''}`));
  ctx.event('sync-config', {
    stage: 'deploy',
    status: syncCode === 0 ? 'ok' : 'fail',
    exitCode: syncCode,
    durationMs: Date.now() - t0s,
  });
  if (syncCode !== 0) {
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'deploy', category: 'harness', severity: 'blocking',
      expected: EXPECTED_SYNC_CONFIG,
      actual: actualSyncConfig(syncCode),
      evidence: ['evidence/sync-config.log'],
    });
    console.error(`deploy: zmp sync-config failed (exit ${syncCode}) — finding ${finding.findingId}`);
    process.exit(1);
  }

  const t0 = Date.now();
  ctx.event('deploy', { stage: 'deploy', status: 'start', command: cmd.join(' ') });
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ws.appDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env, // inherited for zmp-cli; never printed, never logged
  });
  if (res.error) {
    console.error(`deploy: cannot spawn ${cmd[0]}: ${res.error.message}`);
    process.exit(3);
  }
  const exitCode = res.status ?? 1;
  const output = stripAnsi(`${res.stdout || ''}\n${res.stderr || ''}`);
  ctx.writeTextEvidence('evidence/deploy.log', output); // redacted by run-context
  ctx.event('deploy', {
    stage: 'deploy',
    status: exitCode === 0 ? 'ok' : 'fail',
    exitCode,
    durationMs: Date.now() - t0,
  });

  // Auth classifier: pinned message (or -2001 code) → back to the login gate, token expired.
  const authFail = output.includes(zc.authFailureMessage)
    || new RegExp(`(^|[^\\d-])${zc.errorCodes?.permission_denied ?? -2001}\\b`).test(output);
  if (authFail) {
    upsertLoginRequired(ctx, runId);
    ctx.event('deploy', {
      stage: 'deploy',
      status: 'needs_login',
      detail: 'auth failure from zmp-cli (permission_denied) — token missing/expired, login required',
    });
    console.log(JSON.stringify({ runId, stage: 'deploy', status: 'needs_input', reason: 'login_required' }));
    process.exit(2);
  }

  if (exitCode !== 0) {
    // Tier-2: attach a diagnosis when the log matches the curated error-signature map.
    const sig = matchSignatures(output, 'deploy')[0] ?? null;
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'deploy', category: 'dependency', severity: 'blocking',
      expected: EXPECTED_DEPLOY,
      actual: actualDeploy(exitCode),
      evidence: ['evidence/deploy.log'],
      insight: sig,
    });
    console.error(`deploy: zmp deploy failed (exit ${exitCode}) — finding ${finding.findingId}`);
    process.exit(1);
  }

  // Success (FIX finding_42bccd1d5f27): CLI 4.0.3 prints the deployed URL only as a QR after
  // "View app at:". Text parse kept for future CLI versions; QR decode is the working path.
  const textUrl = parseDeployedUrl(output);
  const qrDecodedUrl = decodeQrFromOutput(output);
  const deployedUrl = textUrl ?? qrDecodedUrl;
  if (!deployedUrl) {
    const finding = recordFinding({
      workspace: ws.root, runId, runDir,
      stage: 'deploy', category: 'dependency', severity: 'major',
      expected: EXPECTED_DEPLOY_URL,
      actual: 'zmp deploy exited 0 but neither text URL nor decodable QR was found in output',
      evidence: ['evidence/deploy.log'],
    });
    console.error(`deploy: output unparseable (no deployed URL) — finding ${finding.findingId}`);
    process.exit(1);
  }

  // Phase 2.6 (FAQ 07): quota lines already sit in the deploy output — record them.
  const quota = {};
  const mDev = output.match(/Development:\s*(\d+)\s*\/\s*(\d+)/i);
  const mTest = output.match(/Testing:\s*(\d+)\s*\/\s*(\d+)/i);
  if (mDev) quota.development = { used: Number(mDev[1]), limit: Number(mDev[2]) };
  if (mTest) quota.testing = { used: Number(mTest[1]), limit: Number(mTest[2]) };

  const deployEvidence = {
    schemaVersion: '1.0',
    runId,
    mode,
    deployedUrl,
    quota: mDev || mTest ? quota : null,
    // With QR-only output both fields carry the same decoded URL (schema notes this); the
    // deployed_url_recorded gate enforces equality whenever qrDecodedUrl is non-null.
    qrDecodedUrl,
    versionLabel: parseVersionLabel(output),
    description: desc,
    outputDir,
    deployedAt: new Date().toISOString(),
    cliVersion: zmpCliVersion(zc, output),
  };
  // deploy-evidence.schema.json required fields — an invalid deploy.json must be impossible.
  for (const k of ['schemaVersion', 'runId', 'mode', 'deployedUrl', 'deployedAt', 'cliVersion']) {
    if (deployEvidence[k] == null) {
      console.error(`deploy: internal error — deploy.json missing required field ${k}`);
      process.exit(3);
    }
  }
  ctx.writeJson('evidence/deploy.json', deployEvidence);
  ctx.event('deploy', { stage: 'deploy', status: 'url_recorded', url: deployedUrl });

  console.log(JSON.stringify({ runId, stage: 'deploy', status: 'ok', mode, deployedUrl }));
  process.exit(0);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) main();
