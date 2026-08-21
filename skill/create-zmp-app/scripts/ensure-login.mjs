#!/usr/bin/env node
// ensure-login.mjs — Phase 2 login gate (Subagent C).
//
// KEY-EXISTENCE scan of ZMP_TOKEN in <workspace>/app/.env: the regex anchors on the key
// name at line start and stops at '='. The value is NEVER captured, parsed, logged or
// compared. Token custody stays with zmp-cli (lab.config.json zmpCli.tokenPolicy).
//
// Exit 0: key exists (token may still be expired — deploy.mjs catches -2001 and routes back).
// Exit 2: key missing → result.json upserted to needs_input/login_required (schemaVersion 1.1).
// Exit 3: precondition error.
// This script NEVER spawns `zmp login` — the host agent relays the QR to a human (SKILL.md).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg, loadLabConfig } from './lib/paths.mjs';
import { openRun } from './lib/run-context.mjs';
import { appendPreflight, scanZmpTokenEnvOverride } from './insight.mjs';

const LOGIN_QUESTION =
  'Chưa đăng nhập zmp-cli (app/.env không có key ZMP_TOKEN). Chạy `zmp login` với cwd = app/, ' +
  'quét QR bằng Zalo trong 60s (CLI tự poll và tự lưu token), rồi chạy lại ensure-login/deploy. ' +
  'Tuyệt đối không dùng `zmp login --token ...` qua agent.';

/** Key-existence only. Returns boolean; never exposes anything after '='. */
export function tokenKeyExists(appDir, tokenKey = 'ZMP_TOKEN') {
  const envFile = path.join(appDir, '.env');
  if (!fs.existsSync(envFile)) return false;
  return new RegExp(`^\\s*${tokenKey}\\s*=`, 'm').test(fs.readFileSync(envFile, 'utf8'));
}

/**
 * Upsert runs/<id>/result.json to needs_input/login_required (schemaVersion 1.1).
 * Existing result: only schemaVersion/status/stage/needsInput change — all other fields kept.
 * No result yet: a minimal valid result is created (mirrors bootstrap's needs_input shape).
 */
export function upsertLoginRequired(ctx, runId) {
  const now = new Date().toISOString();
  const existing = ctx.readJson('result.json');
  const result = existing ?? {
    schemaVersion: '1.1',
    runId,
    status: 'needs_input',
    stage: 'login',
    provider: ctx.readJson('input.json')?.renderProvider ?? 'browser',
    appIdSource: null,
    expectedAppId: null,
    resolvedAppId: null,
    appIdBound: false,
    gates: [],
    findingIds: [],
    startedAt: now,
    finishedAt: now,
  };
  result.schemaVersion = '1.1';
  result.status = 'needs_input';
  result.stage = 'login';
  result.needsInput = {
    reason: 'login_required',
    question: LOGIN_QUESTION,
    promptAppId: null,
    projectAppId: null,
  };
  ctx.writeJson('result.json', result);
  return result;
}

/**
 * Inverse of upsertLoginRequired, applied once the token key exists again: a result that is
 * still needs_input/login_required gets its status recomputed from the recorded gates, so the
 * pipeline can continue to deploy (which requires status pass). Other results are untouched.
 */
export function revertLoginRequired(ctx) {
  const result = ctx.readJson('result.json');
  if (!result || result.status !== 'needs_input' || result.needsInput?.reason !== 'login_required') return null;
  const gates = Array.isArray(result.gates) ? result.gates : [];
  const allPass = gates.length > 0 && gates.every((g) => g.status === 'pass');
  result.status = allPass ? 'pass' : 'fail';
  result.stage = allPass ? 'done' : 'verify';
  delete result.needsInput;
  ctx.writeJson('result.json', result);
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  if (!runId) {
    console.error('ensure-login: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`ensure-login: run dir not found: ${runDir}`);
    process.exit(3);
  }
  if (!fs.existsSync(ws.appDir)) {
    console.error(`ensure-login: ${ws.appDir} missing — run bootstrap first`);
    process.exit(3);
  }

  const tokenKey = loadLabConfig().zmpCli?.envKeys?.token ?? 'ZMP_TOKEN';
  const ctx = openRun(ws.runsDir, runId);

  // Phase 2.6 (FAQ 16): a ZMP_TOKEN in the process env silently overrides app/.env — CI/CD
  // trap. Existence-only check, value never read.
  const envHint = scanZmpTokenEnvOverride();
  if (envHint.status === 'warn') {
    appendPreflight(ctx, envHint);
    ctx.event('preflight', { stage: 'login', gateId: envHint.id, status: 'warn', detail: envHint.detail });
  }

  if (tokenKeyExists(ws.appDir, tokenKey)) {
    ctx.event('ensure-login', {
      stage: 'login',
      status: 'ok',
      detail: `${tokenKey} key present in app/.env (key-existence scan only, value never read)`,
    });
    revertLoginRequired(ctx);
    console.log(JSON.stringify({ runId, stage: 'login', status: 'ok' }));
    process.exit(0);
  }

  upsertLoginRequired(ctx, runId);
  ctx.event('ensure-login', {
    stage: 'login',
    status: 'needs_login',
    detail: `${tokenKey} key absent from app/.env — result upserted to needs_input/login_required`,
  });
  console.log(JSON.stringify({ runId, stage: 'login', status: 'needs_input', reason: 'login_required' }));
  process.exit(2);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) main();
