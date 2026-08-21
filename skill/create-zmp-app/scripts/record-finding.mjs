#!/usr/bin/env node
// record-finding.mjs — finding + improvement loop (Subagent C).
// Append/merge findings into <workspace>/feedback/findings.jsonl keyed by fingerprint
// (evaluation/schemas/finding.schema.json), improvements into feedback/improvements.jsonl
// (improvement.schema.json). Also importable: bootstrap.mjs and the other stage scripts
// call recordFinding() so every unexpected error gets a finding before the run ends.
//
// CLI:
//   node record-finding.mjs --workspace <ws> --run-id <id> --stage <s> --category <c> \
//        --severity <sev> --expected <e> --actual <a> [--evidence <csv>]
//   node record-finding.mjs --update <findingId> --status triaged|fixed|verified \
//        [--owner skill|portal|template|dependency|harness] [--verified-by <runId>] [--workspace <ws>]
//   node record-finding.mjs --improve --finding <findingId> --decision <text> --files <csv> \
//        [--regression-case <caseId>] [--verified-by <runId>] [--workspace <ws>]
//
// Exit codes: 0 ok · 3 precondition/usage error (per lab.config.json).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg } from './lib/paths.mjs';
import { redactText } from './lib/redact.mjs';
import { fingerprint, openRun } from './lib/run-context.mjs';

// Phase 2 adds login/deploy (result.schema.json already lists them; finding.schema.json's
// stage enum still needs the same bump — flagged to the lead, schema is lead-owned).
const STAGES = ['input', 'portal', 'scaffold', 'install', 'build', 'render', 'verify', 'login', 'deploy', 'cleanup'];
const CATEGORIES = ['input', 'skill', 'portal-content', 'template', 'app', 'dependency', 'environment', 'harness'];
const SEVERITIES = ['blocking', 'major', 'minor', 'note'];
const STATUSES = ['open', 'triaged', 'fixed', 'verified'];
const OWNERS = ['skill', 'portal', 'template', 'dependency', 'harness'];

function workspaceRoot(workspace) {
  if (workspace && typeof workspace === 'object' && workspace.root) return workspace.root;
  return workspace;
}

function findingsFile(workspace) {
  return path.join(workspaceRoot(workspace), 'feedback', 'findings.jsonl');
}

function improvementsFile(workspace) {
  return path.join(workspaceRoot(workspace), 'feedback', 'improvements.jsonl');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Atomic rewrite: temp file + rename so a crash can never leave a half-written jsonl.
function writeJsonlAtomic(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of [${allowed.join(', ')}], got: ${value}`);
  }
}

/**
 * Append or fingerprint-merge a finding. Returns the full finding object (finding.schema.json).
 * Merge semantics: same fingerprint → occurrences+1, lastSeenAt=now; findingId/firstSeenAt/
 * runId/status and the originally recorded texts stay unchanged.
 */
export function recordFinding({ workspace, runId, runDir, stage, category, severity, expected, actual, evidence = [], insight = null }) {
  const root = workspaceRoot(workspace);
  if (!root) throw new Error('recordFinding: workspace is required');
  if (!runId) throw new Error('recordFinding: runId is required');
  assertEnum(stage, STAGES, 'stage');
  assertEnum(category, CATEGORIES, 'category');
  assertEnum(severity, SEVERITIES, 'severity');
  if (!expected || !actual) throw new Error('recordFinding: expected and actual are required');

  const exp = redactText(String(expected));
  const act = redactText(String(actual));
  const ev = (Array.isArray(evidence) ? evidence : [evidence])
    .filter(Boolean)
    .map((e) => redactText(String(e)));
  // Phase 2.6: optional insight {diagnosis, fix, source} from the error-signature map or a
  // preflight gate (finding.schema.json allows it). Redacted like every other free text.
  const ins = insight && insight.diagnosis && insight.fix
    ? {
      diagnosis: redactText(String(insight.diagnosis)),
      fix: redactText(String(insight.fix)),
      source: insight.source == null ? null : redactText(String(insight.source)),
    }
    : null;

  // fingerprint() (locked lib) lowercases + collapses whitespace on expected/actual-class.
  const fp = fingerprint(stage, category, exp, act);
  const now = new Date().toISOString();

  const file = findingsFile(root);
  const records = readJsonl(file);
  const idx = records.findIndex((r) => r.fingerprint === fp);
  let rec;
  if (idx >= 0) {
    rec = { ...records[idx], occurrences: records[idx].occurrences + 1, lastSeenAt: now };
    // A later occurrence may carry a diagnosis the first one lacked — fill, never overwrite.
    if (ins && !rec.insight) rec.insight = ins;
    records[idx] = rec;
  } else {
    rec = {
      schemaVersion: '1.0',
      findingId: `finding_${fp.slice(0, 12)}`,
      fingerprint: fp,
      runId,
      stage,
      category,
      severity,
      expected: exp,
      actual: act,
      evidence: ev,
      status: 'open',
      firstSeenAt: now,
      lastSeenAt: now,
      occurrences: 1,
    };
    if (ins) rec.insight = ins;
    records.push(rec);
  }
  writeJsonlAtomic(file, records);

  // Trace the finding into the run's append-only event log (allowlist + redaction via run-context).
  const dir = runDir || path.join(root, 'runs', runId);
  try {
    const ctx = openRun(path.dirname(dir), path.basename(dir));
    ctx.event('finding_recorded', { stage, findingId: rec.findingId, detail: `${category}/${severity}` });
  } catch {
    // Event trace is best-effort; the finding itself is already persisted.
  }
  return rec;
}

function cliRecord(argv) {
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  const stage = getArg(argv, 'stage');
  const category = getArg(argv, 'category');
  const severity = getArg(argv, 'severity');
  const expected = getArg(argv, 'expected');
  const actual = getArg(argv, 'actual');
  const evidenceCsv = getArg(argv, 'evidence', '');
  if (!runId || !stage || !category || !severity || !expected || !actual) {
    throw new Error('usage: record-finding.mjs --workspace <ws> --run-id <id> --stage <s> --category <c> --severity <sev> --expected <e> --actual <a> [--evidence <csv>]');
  }
  const evidence = evidenceCsv ? evidenceCsv.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const rec = recordFinding({ workspace: ws.root, runId, stage, category, severity, expected, actual, evidence });
  console.log(JSON.stringify(rec));
}

function cliUpdate(argv) {
  const ws = resolveWorkspace(argv);
  const findingId = getArg(argv, 'update');
  const status = getArg(argv, 'status');
  const owner = getArg(argv, 'owner');
  const verifiedBy = getArg(argv, 'verified-by');
  if (!findingId || !status) {
    throw new Error('usage: record-finding.mjs --update <findingId> --status triaged|fixed|verified [--owner <o>] [--verified-by <runId>] [--workspace <ws>]');
  }
  assertEnum(status, STATUSES.filter((s) => s !== 'open'), 'status');
  if (status === 'triaged' && !owner) throw new Error('--status triaged requires --owner skill|portal|template|dependency|harness');
  if (status === 'verified' && !verifiedBy) throw new Error('--status verified requires --verified-by <runId>');
  if (owner) assertEnum(owner, OWNERS, 'owner');

  const file = findingsFile(ws.root);
  const records = readJsonl(file);
  const idx = records.findIndex((r) => r.findingId === findingId);
  if (idx < 0) throw new Error(`finding not found: ${findingId} (${file})`);
  const rec = { ...records[idx], status };
  if (owner) rec.triagedOwner = owner;
  if (verifiedBy) rec.verifiedByRunId = verifiedBy;
  records[idx] = rec;
  writeJsonlAtomic(file, records);
  console.log(JSON.stringify(rec));
}

function cliImprove(argv) {
  const ws = resolveWorkspace(argv);
  const findingId = getArg(argv, 'finding');
  const decision = getArg(argv, 'decision');
  const filesCsv = getArg(argv, 'files');
  const regressionCaseId = getArg(argv, 'regression-case');
  const verifiedBy = getArg(argv, 'verified-by');
  if (!findingId || !decision || !filesCsv) {
    throw new Error('usage: record-finding.mjs --improve --finding <findingId> --decision <text> --files <csv> [--regression-case <caseId>] [--verified-by <runId>] [--workspace <ws>]');
  }
  const changedFiles = filesCsv.split(',').map((s) => s.trim()).filter(Boolean);
  if (!changedFiles.length) throw new Error('--files must list at least one changed source file');
  const findings = readJsonl(findingsFile(ws.root));
  if (!findings.some((r) => r.findingId === findingId)) {
    throw new Error(`finding not found: ${findingId} — an improvement must link an existing finding`);
  }
  const rec = {
    schemaVersion: '1.0',
    improvementId: `improvement_${crypto.randomBytes(6).toString('hex')}`,
    findingId,
    decision: redactText(String(decision)),
    changedFiles,
    regressionCaseId: regressionCaseId || null,
    verifiedByRunId: verifiedBy || null,
    createdAt: new Date().toISOString(),
  };
  const file = improvementsFile(ws.root);
  const records = readJsonl(file);
  records.push(rec);
  writeJsonlAtomic(file, records);
  console.log(JSON.stringify(rec));
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes('--update')) cliUpdate(argv);
    else if (argv.includes('--improve')) cliImprove(argv);
    else cliRecord(argv);
  } catch (err) {
    console.error(`record-finding: ${err.message}`);
    process.exit(3);
  }
}
