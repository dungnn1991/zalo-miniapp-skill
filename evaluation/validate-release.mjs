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
check('QR login relay explains both computer and phone-app scan paths',
  skillText.includes('Using a computer:')
    && skillText.includes('Using the agent from a phone:')
    && skillText.includes('photo library')
    && deployWorkflowText.includes('Đang dùng máy tính:')
    && deployWorkflowText.includes('Đang dùng agent qua app điện thoại:')
    && deployWorkflowText.includes('thư viện ảnh'),
  'QR relay guidance must cover direct scanning on a computer and saved-image scanning on a phone');

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
{
  // Sổ token-budget (bench/HISTORY.md) phải có row cho version hiện tại và khớp số đo lại
  // từ working tree — track skill phình/teo qua release (bench/README.md). Estimator offline
  // deterministic nên so sánh exact được.
  let ok = false;
  let detail = '';
  const budget = spawnSync(process.execPath, ['bench/token-budget.mjs', '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (budget.status !== 0) {
    detail = `token-budget --json exit ${budget.status}: ${(budget.stderr || '').slice(0, 160)}`;
  } else {
    try {
      const t = JSON.parse(budget.stdout).totals;
      const row = read('bench/HISTORY.md').split(/\r?\n/)
        .find((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l) && l.split('|')[2].trim() === skillPkg.version);
      if (!row) {
        detail = `bench/HISTORY.md không có row cho ${skillPkg.version} — chạy: node bench/token-budget.mjs --record`;
      } else {
        const c = row.split('|').map((s) => s.trim());
        ok = Number(c[3]) === t.tax && Number(c[4]) === t.trigger && Number(c[5]) === t.ondemand;
        if (!ok) detail = `row ${skillPkg.version} ghi ${c[3]}/${c[4]}/${c[5]}, đo lại ra ${t.tax}/${t.trigger}/${t.ondemand} — chạy lại: node bench/token-budget.mjs --record`;
      }
    } catch (err) {
      detail = err.message;
    }
  }
  check('bench token-budget history records current version', ok, detail);
}
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
// Slice B1 (hygiene round 2, DX 55 v2 sau review): nguồn thật của template là
// catalog/templates.json — block config.officialTemplates.catalog deprecated từ plan 34 và
// đã xoá ở B2. Mỗi entry release-supported phải chứng minh được: revision pin khớp hai nơi,
// evidence file nằm trong catalog/qualification + nội dung khớp template/revision/runId + mọi
// blocking gate pass, adapter khai báo tồn tại và khớp id.
const registryTemplates = json('skill/create-zmp-app/catalog/templates.json').templates ?? [];
const ids = registryTemplates.map((t) => t.id);
const supported = registryTemplates.filter((t) => t.qualification?.state === 'release-supported');
check('official template ids are unique', new Set(ids).size === ids.length, JSON.stringify(ids));
check('at least one official template is release-supported', supported.length > 0, 'registry has no release-supported entry');
const qualDir = path.join(SKILL_DIR, 'catalog', 'qualification');
for (const t of supported) {
  const q = t.qualification ?? {};
  check(`${t.id}: support requires immutable revision pinned in source AND qualification`,
    /^[0-9a-f]{40}$/.test(t.source?.revision ?? '') && q.testedRevision === t.source.revision,
    JSON.stringify({ source: t.source?.revision, tested: q.testedRevision }));
  const evRel = q.evidence?.qualificationResult ?? '';
  const evAbs = path.resolve(SKILL_DIR, evRel);
  const inside = evRel !== '' && evAbs.startsWith(qualDir + path.sep) && fs.existsSync(evAbs);
  let ev = null;
  try { ev = inside ? JSON.parse(fs.readFileSync(evAbs, 'utf8')) : null; } catch { ev = null; }
  check(`${t.id}: support requires qualification evidence inside catalog/qualification`, inside && ev !== null,
    evRel || 'evidence.qualificationResult missing');
  if (ev) {
    check(`${t.id}: evidence matches registry (templateId, revision, runId)`,
      ev.templateId === t.id && ev.revision === q.testedRevision && ev.runId === q.evidence?.runId,
      JSON.stringify({ evidence: [ev.templateId, ev.revision, ev.runId], registry: [t.id, q.testedRevision, q.evidence?.runId] }));
    const blocking = (ev.gates ?? []).filter((g) => g.blocking === true);
    check(`${t.id}: every blocking gate in evidence passed`,
      blocking.length > 0 && blocking.every((g) => g.status === 'pass'),
      JSON.stringify(blocking.map((g) => [g.id, g.status])));
  }
  if (q.adapterId) {
    const adPath = path.join(SKILL_DIR, 'catalog', 'adapters', `${t.id}.json`);
    let ad = null;
    try { ad = JSON.parse(fs.readFileSync(adPath, 'utf8')); } catch { ad = null; }
    check(`${t.id}: declared adapter file exists and matches adapterId`,
      ad?.adapterId === q.adapterId && ad?.templateId === t.id,
      JSON.stringify({ file: fs.existsSync(adPath), adapterId: ad?.adapterId ?? null }));
  }
}
check('official-template scaffold path has a committed regression case',
  fs.existsSync(path.join(ROOT, 'evaluation', 'cases', 'official-template-golden', 'case.json')),
  'evaluation/cases/official-template-golden/case.json missing');
{
  // Drift detector: registry entries phải nói cùng ngôn ngữ với template-profile.schema.json
  // (qualification additionalProperties:false) — key lạ = schema hoặc registry đã lệch.
  const profSchema = json('skill/create-zmp-app/schemas/template-profile.schema.json');
  const allowed = new Set(Object.keys(profSchema.properties?.qualification?.properties ?? {}));
  const drift = [];
  for (const t of registryTemplates) {
    for (const k of Object.keys(t.qualification ?? {})) if (!allowed.has(k)) drift.push(`${t.id}.qualification.${k}`);
  }
  check('registry qualification keys are declared in template-profile.schema.json', drift.length === 0, drift.join(', '));
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
{
  // Hygiene gate 3 (round 2 slice A1, 2026-08-28): app/ là generated (LAB.md ownership) —
  // sinh tại chỗ chạy pipeline, không được tracked; tái phạm = ai đó commit output máy sinh.
  const trackedApp = spawnSync('git', ['ls-files', 'app'], { cwd: ROOT, encoding: 'utf8' });
  check('generated app/ is not tracked', (trackedApp.stdout ?? '').trim() === '',
    `tracked: ${(trackedApp.stdout ?? '').trim().split('\n').slice(0, 5).join(', ')} — git rm -r --cached app`);
}
{
  // Hygiene gate 1 (repo-hygiene 2026-08-27): no-orphan references — mọi file trong
  // references/ phải được SKILL.md trỏ tới, nếu không agent không bao giờ tìm thấy nó và
  // file sẽ mục thành bản chép lệch. Fail = thêm dòng vào mục References của SKILL.md
  // hoặc chuyển file ra khỏi references/.
  const refDir = path.join(SKILL_DIR, 'references');
  const orphans = fs.readdirSync(refDir)
    .filter((f) => f.endsWith('.md') || f.endsWith('.json'))
    .filter((f) => !skillText.includes(`references/${f}`));
  check('every references/ file is pointed to by SKILL.md', orphans.length === 0,
    `orphan: ${orphans.join(', ')} — thêm vào mục References của SKILL.md`);
}
{
  // Hygiene gate 4 (round 2 slice A3, 2026-08-28): shipped package phải tự chứa — .md trong
  // skill/create-zmp-app (trừ CHANGELOG lịch sử) không được link tương đối thoát package
  // hay path máy cá nhân; nguồn ngoài repo ghi theo convention "Provenance (DX workspace,
  // không ship cùng skill)".
  const badMentions = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && e.name !== 'CHANGELOG.md') {
        const text = fs.readFileSync(p, 'utf8');
        if (/\]\(\.\.\//.test(text)) badMentions.push(`${path.relative(ROOT, p)}: link ](../ thoát package`);
        if (text.includes('/Users/')) badMentions.push(`${path.relative(ROOT, p)}: absolute path /Users/`);
      }
    }
  };
  walk(SKILL_DIR);
  check('shipped package .md is self-contained (no escaping links / machine paths)',
    badMentions.length === 0, badMentions.join('; '));
}
{
  // Hygiene gate 2 (repo-hygiene 2026-08-27): tập template release-supported trong README
  // phải khớp registry thật catalog/templates.json (cùng pattern đếm-lại-từ-nguồn như gate
  // case-count). Không đọc config.json officialTemplates — block đó deprecated từ plan 34.
  const registry = json('skill/create-zmp-app/catalog/templates.json');
  const regList = Array.isArray(registry) ? registry : registry.templates;
  const supportedIds = regList
    .filter((t) => (t.qualification?.state ?? t.qualification) === 'release-supported')
    .map((t) => String(t.id).replace(/^zaui-/, ''));
  const missing = supportedIds.filter((n) => !readme.includes(n) || !readmeVi.includes(n));
  check('both READMEs list every release-supported template from the registry',
    supportedIds.length > 0 && missing.length === 0,
    `registry supported=[${supportedIds.join(', ')}], thiếu trong README: ${missing.join(', ')}`);
}
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
// A template promoted on simulator evidence must SAY so. Without `qualification.runtime`,
// bootstrap cannot know it needs the simulator and the default scaffold flow verifies the app in
// an environment the evidence never covered — zaui-bistro, zaui-market and zaui-lucky-wheel all
// fail the no-host oracle, so their plain `run.mjs` stopped at render.
const runtimeGaps = [];
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
  if (autoScaffoldable) {
    const rt = q.runtime;
    // Every field is cross-checked against the evidence, not merely present: "verifiedProvider":
    // "banana" used to pass this gate, and the claim "a runtime that contradicts the evidence is
    // blocked" was only ever true for requiresZaloHost.
    const PROVIDERS = new Set(['browser', 'simulator']);
    const oracleProfiles = Object.keys(cfg.oracleProfiles ?? {});
    if (!rt || typeof rt.requiresZaloHost !== 'boolean' || !rt.verifiedProvider || !rt.oracleProfile) {
      runtimeGaps.push(`${t.id}: qualification.runtime missing/incomplete (${JSON.stringify(rt)})`);
    } else {
      if (!PROVIDERS.has(rt.verifiedProvider)) {
        runtimeGaps.push(`${t.id}: runtime.verifiedProvider="${rt.verifiedProvider}" is not one of ${[...PROVIDERS].join('|')}`);
      }
      if (!oracleProfiles.includes(rt.oracleProfile)) {
        runtimeGaps.push(`${t.id}: runtime.oracleProfile="${rt.oracleProfile}" is not in config.json oracleProfiles (${oracleProfiles.join(', ')})`);
      }
      if (ev) {
        if (rt.requiresZaloHost !== ((ev.data.noHostOracle?.exitCode ?? 0) !== 0)) {
          runtimeGaps.push(`${t.id}: runtime.requiresZaloHost=${rt.requiresZaloHost} contradicts evidence noHostOracle.exitCode=${ev.data.noHostOracle?.exitCode}`);
        }
        if (ev.data.oracleProfile && rt.oracleProfile !== ev.data.oracleProfile) {
          runtimeGaps.push(`${t.id}: runtime.oracleProfile="${rt.oracleProfile}" but the evidence was produced under "${ev.data.oracleProfile}"`);
        }
        // The blocking verdict in the factory is the simulator run; a profile whose name starts
        // with "simulator" is exactly what "verifiedProvider: simulator" claims.
        const evidenceProvider = String(ev.data.oracleProfile ?? '').startsWith('simulator') ? 'simulator' : 'browser';
        if (rt.verifiedProvider !== evidenceProvider) {
          runtimeGaps.push(`${t.id}: runtime.verifiedProvider="${rt.verifiedProvider}" but the evidence oracleProfile "${ev.data.oracleProfile}" means "${evidenceProvider}"`);
        }
      }
    }
  }
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
check('every auto-scaffoldable template records the runtime environment it was verified in',
  runtimeGaps.length === 0, runtimeGaps.join(' | '));

// Orphans, the other direction of the same rule bootstrap enforces at runtime: an adapter file
// nobody declared will still load and patch the tree. `adapterId: null` in the registry plus a
// file on disk is exactly as wrong as running the wrong adapter.
const orphanAdapters = [];
const ADAPTERS_DIR = path.join(SKILL_DIR, 'catalog', 'adapters');
if (fs.existsSync(ADAPTERS_DIR)) {
  for (const f of fs.readdirSync(ADAPTERS_DIR).filter((n) => n.endsWith('.json'))) {
    const ad = JSON.parse(fs.readFileSync(path.join(ADAPTERS_DIR, f), 'utf8'));
    const t = (registry.templates ?? []).find((x) => x.id === ad.templateId);
    if (!t) { orphanAdapters.push(`${f}: templateId "${ad.templateId}" is not in the registry`); continue; }
    if (ad.templateId !== path.basename(f, '.json')) {
      orphanAdapters.push(`${f}: templateId "${ad.templateId}" does not match the filename`);
    }
    const declared = t.qualification?.adapterId ?? null;
    // Only enforced for templates the ranker can actually pick: an adapter being prepared for a
    // template nobody can scaffold yet is work in progress, not a live risk.
    const live = AUTO_STATES.has(t.qualification?.state) && !!t.source?.revision
      && t.qualification?.testedRevision === t.source.revision;
    if (live && declared !== ad.adapterId) {
      orphanAdapters.push(`${f}: adapter "${ad.adapterId}" is not declared by ${t.id} (registry adapterId=${JSON.stringify(declared)})`);
    }
  }
}
check('no adapter file is undeclared by the registry it would patch against',
  orphanAdapters.length === 0, orphanAdapters.join(' | '));

const diffCheck = spawnSync('git', ['diff', '--check'], { cwd: ROOT, encoding: 'utf8' });
check('git diff --check is clean', diffCheck.status === 0, diffCheck.stdout || diffCheck.stderr);

for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length} release checks: ${checks.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
