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
const deployWorkflowText = read('skill/create-zmp-app/references/deploy-workflow.md');
const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillText);
let frontmatter = null;
try { frontmatter = fmMatch ? YAML.parse(fmMatch[1]) : null; } catch (err) {
  check('SKILL.md frontmatter parses as YAML', false, err.message);
}
check('SKILL.md has YAML frontmatter', !!fmMatch, 'missing opening/closing --- block');
check('skill name matches folder', frontmatter?.name === 'create-zmp-app', JSON.stringify(frontmatter?.name));
check('skill description is substantive', typeof frontmatter?.description === 'string' && frontmatter.description.length >= 80,
  `length=${frontmatter?.description?.length ?? 0}`);
const qrRelayDocs = `${skillText}\n${deployWorkflowText}`;
check('QR login relay prefers one cropped image and forbids raw PTY streaming',
  skillText.includes('crop the complete QR')
    && deployWorkflowText.includes('crop đủ toàn bộ QR')
    && qrRelayDocs.includes('raw PTY')
    && qrRelayDocs.includes('ANSI')
    && !qrRelayDocs.includes('Relay the QR output verbatim')
    && !qrRelayDocs.includes('Relay nguyên văn khối QR'),
  'QR relay contract regressed to live/raw terminal streaming');

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
const deployQrFixture = 'evaluation/cases/deploy-qr-parse/fixture/deploy.log';
const trackedDeployQrFixture = spawnSync('git', ['ls-files', '--error-unmatch', deployQrFixture], {
  cwd: ROOT,
  encoding: 'utf8',
});
check('deploy QR regression fixture exists and is committed',
  fs.existsSync(path.join(ROOT, deployQrFixture)) && trackedDeployQrFixture.status === 0,
  `${deployQrFixture} is missing or ignored/untracked`);

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
const readmeVi = read('README.vi.md');
const publicReadmes = `${readme}\n${readmeVi}`;
check('README.md is the English default and links the Vietnamese version',
  readme.includes('**English**') && readme.includes('[Tiếng Việt](./README.vi.md)'),
  'missing English default marker or README.vi.md language link');
check('README.vi.md links back to the English default',
  readmeVi.includes('[English](./README.md)') && readmeVi.includes('**Tiếng Việt**'),
  'missing README.md language link or Vietnamese marker');
const officialResourceUrls = [
  'https://docs.zaloplatforms.com/docs/MA',
  'https://miniapp.zaloplatforms.com/',
];
check('both READMEs link the official documentation and Mini App Center',
  officialResourceUrls.every((url) => readme.includes(url) && readmeVi.includes(url)),
  JSON.stringify(officialResourceUrls));
check('README does not advertise all experimental official templates',
  !/11\s+template/i.test(publicReadmes) && !/cà phê dùng mẫu có sẵn/i.test(publicReadmes),
  'a public README still advertises unsupported catalog entries');
check('both READMEs name the supported official template',
  supported.every((entry) => readme.includes(entry.id) && readmeVi.includes(entry.id)),
  JSON.stringify(supported.map((entry) => entry.id)));
const caseCount = fs.readdirSync(path.join(ROOT, 'evaluation', 'cases'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()
    && fs.existsSync(path.join(ROOT, 'evaluation', 'cases', entry.name, 'case.json'))).length;
check('English README behavioral-case count matches the suite',
  new RegExp(`\\b${caseCount}[-\\s]case\\b`, 'i').test(readme),
  `README.md does not state ${caseCount}-case`);
check('Vietnamese README behavioral-case count matches the suite',
  readmeVi.includes(`bộ ${caseCount} case`), `README.vi.md does not state bộ ${caseCount} case`);

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

// --- registry must not contradict its own evidence (report 41 §6.4, review 42 R41-2) --------
// The seeded note "chưa chạy qualification factory" survived zaui-doctor's promotion, so for a
// month the registry claimed nobody had ever run the factory on a template with full evidence,
// on 11 of 12 profiles. And three profiles declared `requiredInputs: []` while their evidence
// said the first preview needs a backend env. Both are the registry lying about work that was
// actually done; a reader cannot tell which fields to trust after that.
const registry = json('skill/create-zmp-app/catalog/templates.json');
const QUAL_DIR = path.join(SKILL_DIR, 'catalog', 'qualification');
const evidenceByTemplate = new Map();
if (fs.existsSync(QUAL_DIR)) {
  for (const f of fs.readdirSync(QUAL_DIR).filter((n) => n.endsWith('.json'))) {
    const d = JSON.parse(fs.readFileSync(path.join(QUAL_DIR, f), 'utf8'));
    evidenceByTemplate.set(d.templateId, { file: `catalog/qualification/${f}`, data: d });
  }
}
const NEVER_RUN_NOTE = 'chưa chạy qualification factory';
const noteLies = [];
const constraintDrift = [];
const adapterGaps = [];
const AUTO_STATES = new Set(['render-qualified', 'interaction-qualified', 'release-supported']);
for (const t of registry.templates ?? []) {
  const q = t.qualification ?? {};
  const c = t.constraints ?? {};
  const ev = evidenceByTemplate.get(t.id);
  if (ev || q.testedRevision) {
    if ((q.note ?? '').includes(NEVER_RUN_NOTE)) noteLies.push(`${t.id}: has evidence but note says "${NEVER_RUN_NOTE}"`);
    if (ev && !(q.note ?? '').includes(ev.file)) noteLies.push(`${t.id}: note does not cite ${ev.file}`);
  } else if (!(q.note ?? '').includes(NEVER_RUN_NOTE)) {
    noteLies.push(`${t.id}: no evidence on disk, but note claims otherwise: "${q.note}"`);
  }
  if (ev) {
    const needed = (ev.data.externalRequirements ?? []).filter((r) => r.neededForFirstPreview).map((r) => r.name).sort();
    const declared = [...(c.requiredInputs ?? [])].sort();
    if (JSON.stringify(needed) !== JSON.stringify(declared)) {
      constraintDrift.push(`${t.id}: evidence needs [${needed.join(', ')}] but requiredInputs=[${declared.join(', ')}]`);
    }
    if (c.backendRequiredForPreview !== (needed.length > 0)) {
      constraintDrift.push(`${t.id}: backendRequiredForPreview=${c.backendRequiredForPreview} vs ${needed.length} first-preview requirement(s)`);
    }
  }
  // An auto-scaffoldable template whose evidence was produced with an adapter MUST ship that
  // adapter, pinned to the same revision — bootstrap refuses at runtime otherwise, and the user
  // would hit it instead of us.
  const autoScaffoldable = AUTO_STATES.has(q.state) && !!t.source?.revision && q.testedRevision === t.source.revision;
  if (autoScaffoldable && q.adapterId) {
    const file = path.join(SKILL_DIR, 'catalog', 'adapters', `${t.id}.json`);
    if (!fs.existsSync(file)) adapterGaps.push(`${t.id}: registry names adapter "${q.adapterId}" but catalog/adapters/${t.id}.json is missing`);
    else {
      const ad = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (ad.adapterId !== q.adapterId) adapterGaps.push(`${t.id}: adapter file is "${ad.adapterId}", registry says "${q.adapterId}"`);
      if (ad.appliesTo?.revision !== t.source.revision) {
        adapterGaps.push(`${t.id}: adapter pinned to ${ad.appliesTo?.revision} but template pinned to ${t.source.revision}`);
      }
    }
  }
}
check('registry qualification notes match the evidence on disk', noteLies.length === 0, noteLies.join(' | '));
check('registry constraints match the evidence on disk', constraintDrift.length === 0, constraintDrift.join(' | '));
check('every auto-scaffoldable template ships the adapter its evidence was produced with',
  adapterGaps.length === 0, adapterGaps.join(' | '));

const diffCheck = spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8' });
check('git diff --check is clean', diffCheck.status === 0, diffCheck.stdout || diffCheck.stderr);

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length} release checks: ${checks.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
