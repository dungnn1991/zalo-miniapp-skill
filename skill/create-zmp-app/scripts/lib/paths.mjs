// Locked path resolution for all create-zmp-app scripts (lead-owned).
// The skill dir is a SELF-CONTAINED package (config.json, schemas/, scripts/ incl. browser
// runner, references/, assets/template/, package.json) — Phase 2.6 packaging.
// Workspace = where generated output lives (app/, runs/, feedback/). Default: process.cwd(),
// ALWAYS — the package location never decides the workspace (a Claude-plugin install carries
// the whole repo, so any content-marker heuristic misfires and writes into the plugin cache;
// finding v0.3.0 P0). The lab redirects explicitly with --workspace <dir> or MB_WORKSPACE.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SKILL_DIR = path.resolve(__dirname, '..', '..');
export const TEMPLATE_DIR = path.join(SKILL_DIR, 'assets', 'template');
export const CONFIG_PATH = path.join(SKILL_DIR, 'config.json');
export const SCHEMAS_DIR = path.join(SKILL_DIR, 'schemas');
export const RUNNER_PATH = path.join(SKILL_DIR, 'scripts', 'browser', 'runner.mjs');

export function loadLabConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function resolveWorkspace(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--workspace');
  let fromArg = null;
  if (i >= 0) {
    const v = argv[i + 1];
    // Never let a flag token double as the workspace path (`--workspace --force-scaffold`
    // would otherwise scaffold into ./--force-scaffold AND enable the flag). Loud exit 3 —
    // this is an invocation error, not something to guess through.
    if (v === undefined || v.startsWith('--')) {
      process.stderr.write('paths: --workspace cần một đường dẫn ngay sau nó\n');
      process.exit(3);
    }
    fromArg = v;
  }
  const ws = path.resolve(fromArg || process.env.MB_WORKSPACE || process.cwd());
  return {
    root: ws,
    appDir: path.join(ws, 'app'),
    runsDir: path.join(ws, 'runs'),
    feedbackDir: path.join(ws, 'feedback'),
  };
}

export function getArg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
