#!/usr/bin/env node
// install.mjs — pnpm install in <workspace>/app + environment.json evidence (Subagent C).
// Exit codes: 0 pass · 1 install failed (finding recorded) · 3 precondition/config error.
// Also importable (main-guarded): verify.mjs reuses the finding texts for fingerprint dedupe.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolveWorkspace, getArg, SKILL_DIR } from './lib/paths.mjs';
import { openRun, sha256 } from './lib/run-context.mjs';
import { recordFinding } from './record-finding.mjs';

const TRACKED_PACKAGES = [
  'react', 'react-dom', 'zmp-ui', 'zmp-sdk',
  'vite', 'zmp-vite-plugin', '@vitejs/plugin-react', 'typescript',
];

// Shared finding texts — verify.mjs reconstructs the same strings so the
// fingerprint dedupe merges its install_ok gate finding into this one.
export const EXPECTED_INSTALL = 'pnpm install exits 0';
export const actualInstall = (code) => `pnpm install exited ${code}`;

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

// Content hash of the whole skill directory: sorted relative-path + sha256-of-content lines.
function hashSkillDir() {
  const files = listFilesRecursive(SKILL_DIR).sort();
  const manifest = files
    .map((rel) => `${rel}\n${sha256(fs.readFileSync(path.join(SKILL_DIR, rel)))}\n`)
    .join('');
  return sha256(manifest);
}

function resolvedVersion(appDir, pkg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', pkg, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const ws = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id');
  if (!runId) {
    console.error('install: --run-id <id> is required');
    process.exit(3);
  }
  const runDir = path.join(ws.runsDir, runId);
  if (!fs.existsSync(runDir)) {
    console.error(`install: run dir not found: ${runDir} — run bootstrap first`);
    process.exit(3);
  }
  if (!fs.existsSync(path.join(ws.appDir, 'package.json'))) {
    console.error(`install: ${path.join(ws.appDir, 'package.json')} missing — run bootstrap first`);
    process.exit(3);
  }

  const ctx = openRun(ws.runsDir, runId);
  const t0 = Date.now();
  ctx.event('install', { stage: 'install', status: 'start', command: 'pnpm install' });

  const res = spawnSync('pnpm', ['install'], {
    cwd: ws.appDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`install: cannot spawn pnpm: ${res.error.message}`);
    process.exit(3);
  }
  const exitCode = res.status ?? 1;
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  // Tail only — enough to debug, keeps evidence small. writeTextEvidence redacts.
  ctx.writeTextEvidence('evidence/install.log', output.split('\n').slice(-400).join('\n'));

  // environment.json is written on success AND failure — failed installs need it most.
  const pnpmVersion = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() || null;
  const resolvedVersions = {};
  for (const pkg of TRACKED_PACKAGES) resolvedVersions[pkg] = resolvedVersion(ws.appDir, pkg);
  ctx.writeJson('environment.json', {
    schemaVersion: '1.0',
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    node: process.version,
    pnpm: pnpmVersion,
    resolvedVersions,
    skillHash: hashSkillDir(),
    appManifestHash: sha256(fs.readFileSync(path.join(ws.appDir, 'package.json'), 'utf8')),
  });

  ctx.event('install', {
    stage: 'install',
    status: exitCode === 0 ? 'ok' : 'fail',
    exitCode,
    durationMs: Date.now() - t0,
  });

  if (exitCode !== 0) {
    const finding = recordFinding({
      workspace: ws.root,
      runId,
      runDir,
      stage: 'install',
      category: 'dependency',
      severity: 'blocking',
      expected: EXPECTED_INSTALL,
      actual: actualInstall(exitCode),
      evidence: ['evidence/install.log'],
    });
    console.error(`install: pnpm install failed (exit ${exitCode}) — finding ${finding.findingId}`);
    process.exit(1);
  }

  console.log(JSON.stringify({ runId, stage: 'install', status: 'ok' }));
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) main();
