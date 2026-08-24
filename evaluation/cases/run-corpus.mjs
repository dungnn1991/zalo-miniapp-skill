#!/usr/bin/env node
// run-corpus.mjs — gold routing corpus runner (plan 34 §6, Subagent C).
//
//   node evaluation/cases/run-corpus.mjs [--all]
//
// Runs every fixture in evaluation/routing-corpus/cases/ through the deterministic ranker
// (skill/create-zmp-app/scripts/recommend-template.mjs, exported `recommend(brief, opts)`)
// IN-PROCESS: no scaffolding, no network, no workspace — the whole corpus is a sub-second run.
//
// Exit codes: 0 every blocking case passed · 1 a blocking case failed · 2
// blocked_dependency_missing (ranker not landed yet) · 3 corpus/usage error.
//
// ---------------------------------------------------------------------------
// Semantics of a fixture (evaluation/routing-corpus/cases/<id>.json)
//
//   expected.decision                  auto | choice | lab | stop  (unconditional)
//   expected.decisionWhenSupported     used when SOME acceptedTemplateId is auto-scaffoldable
//   expected.decisionWhenUnsupported   used otherwise
//
// The conditional pair exists so the suite is honest TODAY and stays correct after a
// promotion: with registry 2026-08-22.1 only `zaui-fashion` is release-supported, so a clinic
// prompt must resolve to lab-with-explanation, not auto. Nothing here hardcodes a green that
// depends on a promotion that has not happened — the runner reads the registry state.
//
//   auto   ranker returns a scaffoldable pick (mode auto|explicit, selectedId + pinned revision)
//   lab    mode=lab, no selection
//   choice ranker asks the user (mode=choice); bootstrap turns this into exit 2 +
//          needsInput.reason=template_choice
//   stop   explicit official:<id> that cannot be honoured — mode explicit|choice with NO pinned
//          revision. `lab` is a FAIL here: silently falling back is exactly DoD #5's failure.
//
// Top-1 is measured on `selectedId ?? highest-scored alternative`, so routing accuracy stays
// measurable for domains whose template is still `candidate` (the pick is visible in
// `alternatives` even when the decision is lab).
//
// Exact-match is used for ids and decisions only — never for explanation prose.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASES_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = path.resolve(CASES_DIR, '..', '..');
const SKILL_DIR = path.join(LAB_ROOT, 'skill', 'create-zmp-app');
const CORPUS_DIR = path.join(LAB_ROOT, 'evaluation', 'routing-corpus', 'cases');
const RANKER = path.join(SKILL_DIR, 'scripts', 'recommend-template.mjs');
const REGISTRY = path.join(SKILL_DIR, 'catalog', 'templates.json');
const TAXONOMY = path.join(SKILL_DIR, 'catalog', 'taxonomy.json');
const SELECTION_SCHEMA = path.join(SKILL_DIR, 'schemas', 'template-selection.schema.json');

const showAll = process.argv.includes('--all');
const DECISIONS = new Set(['auto', 'choice', 'lab', 'stop']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    console.error(`run-corpus: cannot read ${file}: ${err.message}`);
    process.exit(3);
  }
}

// --- minimal JSON-Schema subset validator (enough for template-selection.schema.json) -------
function validate(schema, value, at = '$') {
  const errs = [];
  const types = schema.type == null ? null : [].concat(schema.type);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (types && !types.includes(typeOf(value)) && !(types.includes('integer') && Number.isInteger(value))) {
    errs.push(`${at}: expected type ${types.join('|')}, got ${typeOf(value)}`);
    return errs;
  }
  if ('const' in schema && value !== schema.const) errs.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  if (schema.enum && !schema.enum.some((e) => e === value)) errs.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errs.push(`${at}: missing required "${key}"`);
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      if (props[key]) errs.push(...validate(props[key], sub, `${at}.${key}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected property "${key}"`);
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  return errs;
}

// --- registry ------------------------------------------------------------------------------
const registry = readJson(REGISTRY);
const taxonomy = readJson(TAXONOMY);
const selectionSchema = readJson(SELECTION_SCHEMA);
const byId = new Map(registry.templates.map((t) => [t.id, t]));

// CONTRACT-plan34.md rule 2: auto-scaffold only from a release-supported profile pinned to an
// immutable revision that qualification actually tested. The license check is a PROMOTION gate
// (rule 3, zaui-fashion grandfathered), not a runtime filter — a profile that reached
// release-supported has already been through it.
function autoScaffoldable(id) {
  const t = byId.get(id);
  return !!t
    && t.qualification?.state === 'release-supported'
    && !!t.source?.revision
    && t.qualification?.testedRevision === t.source.revision;
}

// --- corpus load + lint --------------------------------------------------------------------
if (!fs.existsSync(CORPUS_DIR)) {
  console.error(`run-corpus: corpus directory missing: ${CORPUS_DIR}`);
  process.exit(3);
}
const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  console.error(`run-corpus: no fixtures in ${CORPUS_DIR}`);
  process.exit(3);
}

const corpus = [];
const lintErrs = [];
for (const file of files) {
  const c = readJson(path.join(CORPUS_DIR, file));
  const where = `${file}`;
  if (c.id !== path.basename(file, '.json')) lintErrs.push(`${where}: id "${c.id}" does not match filename`);
  if (typeof c.brief !== 'string' || !c.brief.trim()) lintErrs.push(`${where}: brief missing`);
  if (typeof c.blocking !== 'boolean') lintErrs.push(`${where}: blocking must be true|false`);
  const e = c.expected ?? {};
  const declared = [e.decision, e.decisionWhenSupported, e.decisionWhenUnsupported].filter(Boolean);
  if (!declared.length) lintErrs.push(`${where}: needs decision or decisionWhenSupported/decisionWhenUnsupported`);
  if (e.decision && (e.decisionWhenSupported || e.decisionWhenUnsupported)) {
    lintErrs.push(`${where}: decision and decisionWhen* are mutually exclusive`);
  }
  if (!e.decision && !(e.decisionWhenSupported && e.decisionWhenUnsupported)) {
    lintErrs.push(`${where}: conditional cases need BOTH decisionWhenSupported and decisionWhenUnsupported`);
  }
  for (const d of declared) if (!DECISIONS.has(d)) lintErrs.push(`${where}: unknown decision "${d}"`);
  const accepted = e.acceptedTemplateIds ?? [];
  for (const id of accepted) if (!byId.has(id)) lintErrs.push(`${where}: acceptedTemplateIds "${id}" not in registry`);
  for (const id of e.mustNotSelect ?? []) if (!byId.has(id)) lintErrs.push(`${where}: mustNotSelect "${id}" not in registry`);
  for (const id of accepted) if ((e.mustNotSelect ?? []).includes(id)) lintErrs.push(`${where}: "${id}" is both accepted and forbidden`);
  // Taxonomy is a closed enum (plan §4.2): a fixture may not invent domain/job ids, and the
  // domains/jobs it demands must actually be declared by an accepted template.
  const accDomains = new Set(accepted.flatMap((id) => byId.get(id)?.intent?.domains ?? []));
  const accJobs = new Set(accepted.flatMap((id) => byId.get(id)?.intent?.jobs ?? []));
  for (const d of e.requiredDomains ?? []) {
    if (!(d in taxonomy.domains)) lintErrs.push(`${where}: requiredDomains "${d}" not in taxonomy`);
    else if (accepted.length && !accDomains.has(d)) lintErrs.push(`${where}: requiredDomains "${d}" not declared by any accepted template`);
  }
  for (const j of e.requiredJobs ?? []) {
    if (!(j in taxonomy.jobs)) lintErrs.push(`${where}: requiredJobs "${j}" not in taxonomy`);
    else if (accepted.length && !accJobs.has(j)) lintErrs.push(`${where}: requiredJobs "${j}" not declared by any accepted template`);
  }
  corpus.push(c);
}
if (lintErrs.length) {
  console.error(`run-corpus: ${lintErrs.length} corpus lint error(s):`);
  for (const e of lintErrs) console.error(`  - ${e}`);
  process.exit(3);
}

// --- ranker (Subagent A) -------------------------------------------------------------------
function blocked(reason) {
  console.log(JSON.stringify({
    suite: 'routing-corpus', status: 'blocked_dependency_missing', missing: [reason],
    cases: corpus.length,
  }, null, 2));
  process.exit(2);
}
if (!fs.existsSync(RANKER)) blocked('skill/create-zmp-app/scripts/recommend-template.mjs (Subagent A)');
let recommend;
try {
  ({ recommend } = await import(pathToFileURL(RANKER).href));
} catch (err) {
  blocked(`recommend-template.mjs failed to import: ${err.message}`);
}
if (typeof recommend !== 'function') blocked('recommend-template.mjs does not export recommend(brief, opts)');

// --- evaluation ----------------------------------------------------------------------------
function topPick(sel) {
  if (sel.selectedId) return sel.selectedId;
  const alts = (sel.alternatives ?? []).filter((a) => a && typeof a.id === 'string');
  if (!alts.length) return null;
  return alts.reduce((best, a) => (best === null || (a.score ?? -Infinity) > (best.score ?? -Infinity) ? a : best), null)?.id ?? null;
}

function effectiveDecision(c) {
  const e = c.expected;
  if (e.decision) return { decision: e.decision, basis: 'unconditional' };
  const supported = (e.acceptedTemplateIds ?? []).some(autoScaffoldable);
  return {
    decision: supported ? e.decisionWhenSupported : e.decisionWhenUnsupported,
    basis: supported ? 'registry: accepted template is release-supported' : 'registry: no accepted template is release-supported yet',
  };
}

function evaluate(c, sel) {
  const why = [];
  const e = c.expected;
  const { decision, basis } = effectiveDecision(c);
  const mode = sel.mode;
  const pick = topPick(sel);
  const forbidden = new Set(e.mustNotSelect ?? []);
  const scaffoldable = sel.selectedId != null && sel.revision != null;

  // schema conformance of the ranker output (locked contract)
  for (const err of validate(selectionSchema, sel)) why.push(`schema ${err}`);

  // ---- global safety invariants, applied to EVERY case (plan §2.2 safety negative set) ----
  if (sel.selectedId != null && !byId.has(sel.selectedId)) why.push(`selectedId "${sel.selectedId}" is not in the registry`);
  for (const a of sel.alternatives ?? []) {
    if (a?.id != null && !byId.has(a.id)) why.push(`alternatives contains unknown id "${a.id}"`);
  }
  if (sel.revision != null) {
    if (!autoScaffoldable(sel.selectedId)) why.push(`pinned a revision for "${sel.selectedId}" which is not release-supported/tested`);
    else if (sel.revision !== byId.get(sel.selectedId).source.revision) why.push(`revision ${sel.revision} != registry pin ${byId.get(sel.selectedId).source.revision}`);
  }
  if (mode === 'auto' && !autoScaffoldable(sel.selectedId)) why.push(`mode=auto on "${sel.selectedId}" which is not auto-scaffoldable today`);

  // ---- decision ----
  if (decision === 'auto') {
    if (!(mode === 'auto' || mode === 'explicit')) why.push(`expected an auto pick, got mode=${mode}`);
    if (!scaffoldable) why.push(`expected a scaffoldable pick (selectedId + pinned revision), got selectedId=${sel.selectedId} revision=${sel.revision}`);
  } else if (decision === 'lab') {
    if (mode !== 'lab') why.push(`expected mode=lab, got mode=${mode}`);
    if (sel.selectedId != null) why.push(`lab must not select a template, got "${sel.selectedId}"`);
  } else if (decision === 'choice') {
    if (mode !== 'choice') why.push(`expected mode=choice (one clarifying question), got mode=${mode}`);
    const opts = (sel.alternatives ?? []).map((a) => a?.id).filter(Boolean);
    const min = e.minOptions ?? 2;
    if (new Set(opts).size < min) why.push(`choice needs >= ${min} distinct options, got [${opts.join(', ')}]`);
  } else if (decision === 'stop') {
    if (mode === 'lab') why.push('explicit override must stop and explain, not fall back to lab');
    if (!(mode === 'explicit' || mode === 'choice')) why.push(`expected mode=explicit|choice for a stop, got mode=${mode}`);
    if (scaffoldable) why.push(`must stop before mutation, but returned a scaffoldable pick "${sel.selectedId}"`);
  }

  // ---- top-1 ----
  const scored = (e.acceptedTemplateIds ?? []).length > 0;
  let top1Ok = null;
  if (scored) {
    top1Ok = pick != null && e.acceptedTemplateIds.includes(pick);
    if (!top1Ok) why.push(`top-1 "${pick}" not in accepted [${e.acceptedTemplateIds.join(', ')}]`);
    // DoD #1: when the right template exists but is not supported yet, say so — do not drop it.
    if (decision === 'lab') {
      const alt = (sel.alternatives ?? []).find((a) => e.acceptedTemplateIds.includes(a?.id));
      if (!alt) why.push(`lab fallback must still list [${e.acceptedTemplateIds.join(', ')}] in alternatives with a reason`);
      else if (!alt.rejectedBecause) why.push(`alternatives["${alt.id}"] has no rejectedBecause — the report must explain why it was not used`);
    }
  } else if (e.forbidSelection) {
    if (sel.selectedId != null) why.push(`no template may be selected here, got "${sel.selectedId}"`);
  }

  // ---- mustNotSelect ----
  if (sel.selectedId != null && forbidden.has(sel.selectedId)) why.push(`selected forbidden template "${sel.selectedId}"`);
  if (pick != null && forbidden.has(pick)) why.push(`top-1 is forbidden template "${pick}"`);
  if (decision === 'choice') {
    for (const a of sel.alternatives ?? []) {
      if (forbidden.has(a?.id)) why.push(`offered forbidden template "${a.id}" as a choice`);
    }
  }

  return { ok: why.length === 0, decision, basis, mode, pick, scored, top1Ok, why };
}

const results = [];
for (const c of corpus) {
  let sel = null;
  let crash = null;
  try {
    sel = await recommend(c.brief, { template: c.templateFlag ?? 'auto' });
  } catch (err) {
    crash = `recommend() threw: ${err.message}`;
  }
  if (crash) {
    results.push({ c, ok: false, why: [crash], decision: effectiveDecision(c).decision, mode: null, pick: null, scored: false, top1Ok: null });
    continue;
  }
  if (sel === null || typeof sel !== 'object') {
    results.push({ c, ok: false, why: [`recommend() returned ${JSON.stringify(sel)}`], decision: effectiveDecision(c).decision, mode: null, pick: null, scored: false, top1Ok: null });
    continue;
  }
  results.push({ c, ...evaluate(c, sel), sel });
}

// --- report --------------------------------------------------------------------------------
const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

function table(rows, title) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  console.log(`${'case'.padEnd(38)} ${'brief'.padEnd(46)} ${'expect'.padEnd(7)} ${'got'.padEnd(9)} why`);
  console.log('-'.repeat(140));
  for (const r of rows) {
    const got = `${r.mode ?? 'n/a'}${r.pick ? `:${r.pick}` : ''}`;
    console.log(`${trim(r.c.id, 38)} ${trim(r.c.brief, 46)} ${trim(r.decision, 7)} ${trim(got, 9)} ${r.why.join(' | ')}`);
  }
}

const blocking = results.filter((r) => r.c.blocking);
const discovery = results.filter((r) => !r.c.blocking);
const bFail = blocking.filter((r) => !r.ok);
const dFail = discovery.filter((r) => !r.ok);

// A discovery case is exploratory ONLY while its failure stays theoretical. The moment the
// ranker actually auto-selects a template it can build, the failure stops being a note about
// future coverage and becomes a description of what the skill will really do to a user's brief.
//
// Measured 2026-08-23, the day zaui-lucky-wheel was promoted: "app cà phê có tích điểm thành
// viên", "app tạp hoá có thanh toán và tích điểm khách hàng" and "app bán voucher du lịch giá
// rẻ" all auto-selected zaui-lucky-wheel — three silent wrong scaffolds, and the release gate
// stayed green because discovery is informational. That is the hole this closes: an
// unsafe-and-live discovery failure gates the suite exactly like a blocking one.
//
// `choice` and `lab` outcomes stay informational: they ask or fall back, they do not build the
// wrong thing.
const unsafeAutoRoute = (r) => r.mode === 'auto'
  && r.sel?.selectedId != null
  && r.sel?.revision != null
  && autoScaffoldable(r.sel.selectedId);
const dLive = dFail.filter(unsafeAutoRoute);

table(showAll ? blocking : bFail, showAll ? 'BLOCKING (all)' : 'BLOCKING failures');
table(dLive, 'DISCOVERY failures that AUTO-SCAFFOLD a release-supported template (these gate the suite)');
table(showAll ? discovery : dFail.filter((r) => !unsafeAutoRoute(r)),
  showAll ? 'DISCOVERY (all, informational)' : 'DISCOVERY failures (informational — do not gate the suite)');

function acc(rows) {
  const s = rows.filter((r) => r.scored);
  const hit = s.filter((r) => r.top1Ok).length;
  return { scored: s.length, hit, pct: s.length ? (100 * hit) / s.length : null };
}
const bAcc = acc(blocking);
const dAcc = acc(discovery);

const byGroup = {};
for (const r of blocking) {
  const g = (byGroup[r.c.group ?? 'ungrouped'] ??= { total: 0, pass: 0 });
  g.total++; if (r.ok) g.pass++;
}

console.log('\n--- routing corpus ------------------------------------------------------------');
console.log(`registry ${registry.registryVersion} · taxonomy ${registry.taxonomyVersion} · auto-scaffoldable today: ${registry.templates.filter((t) => autoScaffoldable(t.id)).map((t) => t.id).join(', ') || '(none)'}`);
console.log(`blocking : ${blocking.length - bFail.length}/${blocking.length} pass · top-1 ${bAcc.hit}/${bAcc.scored}${bAcc.pct === null ? '' : ` (${bAcc.pct.toFixed(1)}%)`} · gate top-1 >= 90%`);
console.log(`discovery: ${discovery.length - dFail.length}/${discovery.length} pass · top-1 ${dAcc.hit}/${dAcc.scored}${dAcc.pct === null ? '' : ` (${dAcc.pct.toFixed(1)}%)`} · informational except unsafe auto-routes`);
console.log(`unsafe   : ${dLive.length} discovery failure(s) auto-scaffold a release-supported template · gate 0`);
console.log(`by group : ${Object.entries(byGroup).map(([g, v]) => `${g} ${v.pass}/${v.total}`).join(' · ')}`);

console.log(JSON.stringify({
  suite: 'routing-corpus',
  status: bFail.length || dLive.length ? 'fail' : 'pass',
  registryVersion: registry.registryVersion,
  blocking: { total: blocking.length, pass: blocking.length - bFail.length, fail: bFail.length, top1: bAcc },
  discovery: { total: discovery.length, pass: discovery.length - dFail.length, fail: dFail.length, top1: dAcc },
  unsafeAutoRoutes: dLive.map((r) => ({ id: r.c.id, selected: r.sel?.selectedId })),
  failing: [...bFail, ...dLive].map((r) => r.c.id),
}));

process.exit(bFail.length || dLive.length ? 1 : 0);
