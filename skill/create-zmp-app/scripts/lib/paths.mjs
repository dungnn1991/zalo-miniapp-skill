// Locked path resolution for all create-zmp-app scripts (lead-owned).
// The skill dir is a SELF-CONTAINED package (config.json, schemas/, scripts/ incl. browser
// runner, references/, assets/template/, package.json) — Phase 2.6 packaging.
// Workspace = where generated output lives (app/, runs/, feedback/). Default: the lab root
// when the package sits inside the dev lab (evaluation/cases marker), else process.cwd()
// (shipped/standalone mode). Redirect with --workspace <dir> or MB_WORKSPACE.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SKILL_DIR = path.resolve(__dirname, '..', '..');
export const TEMPLATE_DIR = path.join(SKILL_DIR, 'assets', 'template');
export const CONFIG_PATH = path.join(SKILL_DIR, 'config.json');
export const SCHEMAS_DIR = path.join(SKILL_DIR, 'schemas');
export const RUNNER_PATH = path.join(SKILL_DIR, 'scripts', 'browser', 'runner.mjs');

// Lab layout: .../labs/miniapp-bootstrap-poc/skill/create-zmp-app — two levels up.
// In a shipped copy this resolves to arbitrary parents; the marker check below decides.
export const LAB_ROOT = path.resolve(SKILL_DIR, '..', '..');
export const IN_LAB = fs.existsSync(path.join(LAB_ROOT, 'evaluation', 'cases'));

export function loadLabConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function resolveWorkspace(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--workspace');
  const fromArg = i >= 0 ? argv[i + 1] : null;
  const ws = path.resolve(fromArg || process.env.MB_WORKSPACE || (IN_LAB ? LAB_ROOT : process.cwd()));
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
