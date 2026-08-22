#!/usr/bin/env node
// Deterministic release metadata/packaging validation. This complements behavioral cases:
// it catches version drift, invalid skill UI metadata, duplicate discovery paths, accidental
// public exposure of unverified/mutable official templates, and a permissive CI definition.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { suiteExitCode } from './lib/suite-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = path.join(ROOT, 'skill', 'create-zmp-app');
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) });
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function json(file) {
  return JSON.parse(read(file));
}

const skillText = read('skill/create-zmp-app/SKILL.md');
const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillText);
let frontmatter = null;
try { frontmatter = fmMatch ? YAML.parse(fmMatch[1]) : null; } catch (err) {
  check('SKILL.md frontmatter parses as YAML', false, err.message);
}
check('SKILL.md has YAML frontmatter', !!fmMatch, 'missing opening/closing --- block');
check('skill name matches folder', frontmatter?.name === 'create-zmp-app', JSON.stringify(frontmatter?.name));
check('skill description is substantive', typeof frontmatter?.description === 'string' && frontmatter.description.length >= 80,
  `length=${frontmatter?.description?.length ?? 0}`);

let openai = null;
try { openai = YAML.parse(read('skill/create-zmp-app/agents/openai.yaml')); } catch (err) {
  check('agents/openai.yaml parses as YAML', false, err.message);
}
const ui = openai?.interface ?? {};
check('openai display_name present', typeof ui.display_name === 'string' && ui.display_name.length > 0, JSON.stringify(ui));
check('openai short_description is 25–64 chars',
  typeof ui.short_description === 'string' && ui.short_description.length >= 25 && ui.short_description.length <= 64,
  `length=${ui.short_description?.length ?? 0}`);
check('openai default_prompt explicitly invokes $create-zmp-app and fits host limit',
  typeof ui.default_prompt === 'string' && ui.default_prompt.includes('$create-zmp-app') && ui.default_prompt.length <= 128,
  JSON.stringify(ui.default_prompt));
check('implicit invocation remains enabled', openai?.policy?.allow_implicit_invocation === true,
  JSON.stringify(openai?.policy));

const skillPkg = json('skill/create-zmp-app/package.json');
const plugin = json('.claude-plugin/plugin.json');
const changelog = read('skill/create-zmp-app/CHANGELOG.md');
check('Claude plugin and skill package versions match', plugin.version === skillPkg.version,
  `${plugin.version} != ${skillPkg.version}`);
check('CHANGELOG has current version heading',
  changelog.includes(`## [${skillPkg.version}]`), `missing ## [${skillPkg.version}]`);
let findings = [];
let improvements = [];
try {
  findings = read('feedback/findings.jsonl').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  improvements = read('feedback/improvements.jsonl').split(/\r?\n/).filter(Boolean).map(JSON.parse);
} catch (err) {
  check('feedback audit trail parses as JSONL', false, err.message);
}
const findingIds = new Set(findings.map((record) => record.findingId));
const improvedFindingIds = new Set(improvements.map((record) => record.findingId));
const citedFindingIds = [...new Set(changelog.match(/finding_[a-z0-9_-]+/g) ?? [])];
check('CHANGELOG finding references resolve to durable audit records',
  citedFindingIds.length > 0 && citedFindingIds.every((id) => findingIds.has(id)),
  JSON.stringify(citedFindingIds.filter((id) => !findingIds.has(id))));
check('CHANGELOG finding references link to improvements',
  citedFindingIds.every((id) => improvedFindingIds.has(id)),
  JSON.stringify(citedFindingIds.filter((id) => !improvedFindingIds.has(id))));
check('Claude plugin exposes exactly one canonical skill path',
  JSON.stringify(plugin.skills) === JSON.stringify(['./skill/create-zmp-app']), JSON.stringify(plugin.skills));
check('duplicate legacy skills/create-zmp-app path is absent',
  !fs.existsSync(path.join(ROOT, 'skills', 'create-zmp-app')), 'legacy duplicate still exists');
check('root .env is absent and ignored',
  !fs.existsSync(path.join(ROOT, '.env')) && read('.gitignore').split(/\r?\n/).includes('.env'),
  'remove tracked root .env and add exact .env ignore rule');

const cfg = json('skill/create-zmp-app/config.json');
const catalog = cfg.officialTemplates?.catalog ?? [];
const ids = catalog.map((entry) => entry.id);
const supported = catalog.filter((entry) => entry.releaseSupported === true);
check('official template ids are unique', new Set(ids).size === ids.length, JSON.stringify(ids));
check('at least one official template is release-supported', supported.length > 0, 'supported catalog is empty');
for (const entry of supported) {
  check(`${entry.id}: support requires verified evidence`, entry.verified === true, JSON.stringify(entry));
  check(`${entry.id}: support requires immutable commit revision`, /^[0-9a-f]{40}$/.test(entry.revision ?? ''),
    JSON.stringify(entry.revision));
  check(`${entry.id}: support requires a committed regression case`,
    typeof entry.releaseCaseId === 'string'
      && fs.existsSync(path.join(ROOT, 'evaluation', 'cases', entry.releaseCaseId, 'case.json')),
    JSON.stringify(entry.releaseCaseId));
}
check('official tarball URL resolves immutable revision, not branch',
  cfg.officialTemplates?.tarballUrlPattern?.includes('{revision}')
    && !cfg.officialTemplates.tarballUrlPattern.includes('{branch}'),
  cfg.officialTemplates?.tarballUrlPattern);

const readme = read('README.md');
check('README does not advertise all experimental official templates',
  !/11\s+template/i.test(readme) && !/cà phê dùng mẫu có sẵn/i.test(readme),
  'public README still advertises unsupported catalog entries');
check('README names the supported official template',
  supported.every((entry) => readme.includes(entry.id)), JSON.stringify(supported.map((entry) => entry.id)));
const caseCount = fs.readdirSync(path.join(ROOT, 'evaluation', 'cases'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()
    && fs.existsSync(path.join(ROOT, 'evaluation', 'cases', entry.name, 'case.json'))).length;
check('README behavioral-case count matches the suite',
  readme.includes(`bộ ${caseCount} case`), `README does not state bộ ${caseCount} case`);

let workflow = null;
try { workflow = YAML.parse(read('.github/workflows/ci.yml')); } catch (err) {
  check('CI workflow parses as YAML', false, err.message);
}
const workflowText = read('.github/workflows/ci.yml');
check('CI exposes stable release-gate status context',
  workflow?.name === 'release-gate' && workflow?.jobs?.['release-gate']?.name === 'release-gate',
  JSON.stringify({ name: workflow?.name, jobs: Object.keys(workflow?.jobs ?? {}) }));
check('CI invokes strict npm test without allow-blocked escape hatch',
  /npm test/.test(workflowText) && !/npm test[^\n]*--allow-blocked/.test(workflowText), 'CI command is not strict');
check('release suite treats blocked as failure by default',
  suiteExitCode([{ status: 'blocked' }]) === 1
    && suiteExitCode([{ status: 'blocked' }], { allowBlocked: true }) === 0
    && suiteExitCode([{ status: 'fail' }], { allowBlocked: true }) === 1,
  'suite exit policy does not distinguish strict release and exploratory modes');

const diffCheck = spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8' });
check('git diff --check is clean', diffCheck.status === 0, diffCheck.stdout || diffCheck.stderr);

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length} release checks: ${checks.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
