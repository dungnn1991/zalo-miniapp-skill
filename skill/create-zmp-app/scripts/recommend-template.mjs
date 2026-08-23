#!/usr/bin/env node
// recommend-template.mjs — deterministic template ranker (plan 34 §4.3, CONTRACT-plan34 A).
//
// Pure function of (brief, catalog/templates.json, catalog/taxonomy.json). No agent, no LLM,
// no network, no clock, no randomness: same input ⇒ same output, byte for byte. The registry
// is the ONLY source of truth for state/revision/qualification; this file never fetches a
// mutable catalog and never promotes a template.
//
// API:
//   recommend(brief, opts)      -> templateSelection, valid against
//                                  schemas/template-selection.schema.json
//   rankTemplates(brief, opts)  -> { selection, templateOptions, blocked, candidates, intent }
//                                  (superset for bootstrap: choice options + explicit block)
//   AUTO_SELECT_MIN_SCORE / AUTO_SELECT_MIN_MARGIN / WEIGHTS — the tunables, exported so the
//   corpus runner can report against them.
//
// opts: { registry, taxonomy, template, providedInputs }
//   registry/taxonomy  pre-parsed objects (tests/corpus); default = read from SKILL_DIR/catalog
//   template           'auto' (default) | 'lab' | 'official:<id>'
//   providedInputs     string[] of constraint inputs the caller can already satisfy
//
// CLI (debugging only — the pipeline calls the API):
//   node recommend-template.mjs --brief "tạo app phòng khám đặt lịch" [--template auto|lab|official:<id>]
//                               [--registry <file>] [--taxonomy <file>] [--verbose]
//
// Ranking pipeline: normalize → intent (domains/jobs/capabilities from the registry's own
// phrases + the taxonomy lexicon below) → HARD-FILTER (support gates, before scoring is used
// for anything) → score → decision table. Everything rejected still shows up in
// `alternatives[]` with `rejectedBecause`, so a run can always explain what it did not pick.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_DIR, getArg } from './lib/paths.mjs';
import { normalizeVi, matchSpan, matchNormalized } from './lib/text-match.mjs';

export const CATALOG_DIR = path.join(SKILL_DIR, 'catalog');
export const TEMPLATES_PATH = path.join(CATALOG_DIR, 'templates.json');
export const TAXONOMY_PATH = path.join(CATALOG_DIR, 'taxonomy.json');

// --- Thresholds ----------------------------------------------------------------------
// PROVISIONAL. Both numbers are hand-set for the 2026-08-22 registry (1 release-supported
// template) and MUST be re-derived from the gold corpus in plan 34 P3 before v0.4.0 ships;
// they are exported, never inlined, so a calibration run changes exactly two literals.
//   AUTO_SELECT_MIN_SCORE  = one primary-domain match (WEIGHTS.domainPrimary). Rationale: no
//                            domain evidence ⇒ never auto-scaffold, whatever else matched.
//   AUTO_SELECT_MIN_MARGIN = more than one alias hit (2 × WEIGHTS.aliasHit ... minus nothing).
//                            Two templates in the same domain that differ only by a single
//                            alias hit are NOT a confident win — they are a question.
export const AUTO_SELECT_MIN_SCORE = 10;
export const AUTO_SELECT_MIN_MARGIN = 4;

// Named, individually logged score components (plan §4.3). No `portalListed` weight: review
// 35 §3 — with today's data it duplicates the qualification hard-filter and adds a
// coefficient nobody has calibrated.
export const WEIGHTS = Object.freeze({
  domainPrimary: 10,   // strongest signal: the brief's main domain is one this template declares
  domainSecondary: 4,  // template covers a domain the brief mentions, but not the main one
  job: 3,              // jobs-to-be-done the template declares and the brief asks for
  capability: 1.5,     // capability coverage
  aliasHit: 2,         // template-specific alias/audience phrase found in the brief
  negativeSignal: -25, // must be able to FLIP a decision, not just shave it
  constraintUnmet: -6, // required input / backend the caller cannot satisfy for first preview
});
// Diminishing returns: repeating "sản phẩm, giỏ hàng, đặt hàng, thanh toán" must not out-shout
// a domain match (plan R9).
export const HIT_CAPS = Object.freeze({ job: 3, capability: 3, alias: 3 });

// Two product flows count as "different" (⇒ ask instead of guess) when their declared job
// sets barely overlap.
const DIFFERENT_FLOW_MAX_JACCARD = 0.5;

// Templates already shipping before licenseDecision existed. CONTRACT-plan34 rule 3:
// "License là gate của promotion, không hồi tố" — zaui-fashion is grandfathered, but no NEW
// template may reach release-supported while licenseDecision='review-required' (D34-8).
// Bậc tối thiểu để được auto-scaffold. Official template đi qua oracle profile
// `official-template`, vốn bỏ marker/interaction gate của lab, nên factory không bao giờ cấp
// được `interaction-qualified`/`release-supported` cho chúng — lấy `release-supported` làm
// điều kiện cứng sẽ khiến 9 template Portal vĩnh viễn không dùng được.
// `render-qualified` nghĩa là: clean install + build, mount thật, có nội dung, không console
// error, không tràn ngang ở 3 viewport, App ID bind đúng, rerun an toàn. Nó KHÔNG chứng minh
// các luồng nghiệp vụ chạy đúng — điều đó cần interaction smoke riêng cho từng template và là
// bậc `interaction-qualified` phía trên.
export const AUTO_SCAFFOLD_STATES = Object.freeze([
  'render-qualified',
  'interaction-qualified',
  'release-supported',
]);

export const LICENSE_GRANDFATHERED = Object.freeze(['zaui-fashion']);

// --- Lexicon -------------------------------------------------------------------------
// Domain phrases are NOT hardcoded here: they are derived from the registry itself
// (intent.aliases + intent.audiences of every template declaring the domain), so the catalog
// stays the source of truth for what a domain sounds like.
// Jobs/capabilities have no phrase surface in the registry (templates declare ids only), so
// the taxonomy description is used as a phrase and this table adds the synonyms/paraphrases
// the corpus needs. Keys are validated against taxonomy — an unknown id fails loud.
const JOB_PHRASES = Object.freeze({
  'product.browse': ['xem sản phẩm', 'danh mục sản phẩm', 'browse products', 'xem hàng hoá'],
  'product.search': ['tìm sản phẩm', 'tìm kiếm sản phẩm', 'search products', 'tra cứu sản phẩm'],
  'cart.manage': ['giỏ hàng', 'cart', 'thêm vào giỏ'],
  'order.place': ['đặt hàng', 'mua hàng', 'chốt đơn', 'place order'],
  'order.track': ['theo dõi đơn', 'tra cứu đơn hàng', 'trạng thái đơn', 'track order'],
  'food.order': ['gọi món', 'đặt món', 'gọi đồ ăn', 'đặt đồ ăn', 'order food'],
  'menu.view': ['thực đơn', 'menu', 'xem menu', 'digital menu'],
  'table.reserve': ['đặt bàn', 'giữ bàn', 'table booking', 'book a table'],
  'delivery.track': ['giao hàng', 'giao đồ ăn', 'theo dõi giao hàng', 'delivery', 'ship đồ'],
  'appointment.booking': [
    'đặt lịch', 'đặt hẹn', 'hẹn giờ', 'đặt khám', 'đăng ký khám', 'lấy hẹn',
    'appointment', 'booking', 'book consultation',
  ],
  'doctor.search': ['tìm bác sĩ', 'tra cứu bác sĩ', 'danh sách bác sĩ', 'chuyên khoa', 'find a doctor'],
  'medical-history.view': ['hồ sơ bệnh án', 'bệnh án', 'lịch sử khám', 'hồ sơ khám', 'medical history'],
  'course.browse': ['ngành học', 'khóa học', 'chương trình đào tạo', 'courses'],
  'admission.apply': ['tuyển sinh', 'nộp hồ sơ', 'xét tuyển', 'nhập học', 'admission'],
  'schedule.view': ['lịch học', 'thời khoá biểu', 'lịch sự kiện', 'xem lịch', 'schedule'],
  'procedure.lookup': ['tra cứu thủ tục', 'thủ tục hành chính', 'hồ sơ thủ tục'],
  'queue.number': ['lấy số', 'bốc số', 'số thứ tự', 'xếp hàng'],
  'reward.spin': ['quay thưởng', 'vòng quay', 'lucky wheel', 'minigame', 'trúng thưởng'],
  'loyalty.points': ['tích điểm', 'điểm thưởng', 'khách hàng thân thiết', 'loyalty'],
  'voucher.redeem': ['voucher', 'đổi quà', 'mã giảm giá', 'ưu đãi', 'coupon'],
});

const CAPABILITY_PHRASES = Object.freeze({
  checkout: ['thanh toán', 'checkout', 'payment'],
  booking: ['đặt lịch', 'đặt hẹn', 'lịch hẹn', 'khung giờ', 'booking', 'appointment'],
  search: ['tìm kiếm', 'tra cứu', 'search'],
  forms: ['biểu mẫu', 'điền form', 'nhập liệu'],
  profile: ['hồ sơ cá nhân', 'tài khoản', 'profile'],
  'oa-chat': ['chat oa', 'official account', 'nhắn tin oa'],
  loyalty: ['thẻ thành viên', 'tích điểm', 'loyalty'],
  delivery: ['giao hàng', 'delivery', 'ship'],
  map: ['bản đồ', 'chỉ đường', 'vị trí cửa hàng'],
  'media-upload': ['tải ảnh', 'upload ảnh', 'đính kèm tệp'],
});

// --- Loading -------------------------------------------------------------------------
export function loadRegistry(file = TEMPLATES_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadTaxonomy(file = TAXONOMY_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertLexiconIds(taxonomy) {
  const bad = [
    ...Object.keys(JOB_PHRASES).filter((id) => !(id in (taxonomy.jobs ?? {}))).map((id) => `job:${id}`),
    ...Object.keys(CAPABILITY_PHRASES).filter((id) => !(id in (taxonomy.capabilities ?? {}))).map((id) => `capability:${id}`),
  ];
  if (bad.length) {
    throw new Error(`recommend-template: lexicon references ids missing from taxonomy: ${bad.join(', ')}`);
  }
}

// --- Intent extraction (deterministic fallback envelope) ------------------------------
// Ordered, deduplicated hits. Sorting is by phrase length (specific before generic) then
// alphabetically, so capping is deterministic.
function sortHits(hits) {
  return [...hits].sort((a, b) => b.keyword.length - a.keyword.length || a.keyword.localeCompare(b.keyword));
}

function collectHits(normText, rawText, phrases) {
  const seen = new Map();
  for (const phrase of phrases) {
    const m = matchSpan(normText, rawText, phrase);
    if (m && !seen.has(m.keyword)) seen.set(m.keyword, m);
  }
  return sortHits([...seen.values()]);
}

// domain id -> phrases, straight from the registry (aliases + audiences of the templates
// declaring that domain).
export function buildDomainLexicon(registry) {
  const lex = new Map();
  for (const t of registry.templates ?? []) {
    const phrases = [...(t.intent?.aliases ?? []), ...(t.intent?.audiences ?? [])];
    for (const domain of t.intent?.domains ?? []) {
      if (!lex.has(domain)) lex.set(domain, new Set());
      for (const p of phrases) lex.get(domain).add(p);
    }
  }
  return lex;
}

// optInPhrases sống trong config.json (legacy từ Phase 2.5). Đọc lười + cache; thiếu file
// hoặc thiếu key thì coi như không có tín hiệu, không throw.
let OPT_IN_CACHE = null;
function optInPhrases() {
  if (OPT_IN_CACHE) return OPT_IN_CACHE;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));
    OPT_IN_CACHE = cfg?.officialTemplates?.optInPhrases ?? [];
  } catch {
    OPT_IN_CACHE = [];
  }
  return OPT_IN_CACHE;
}

export function extractIntent(brief, { registry, taxonomy }) {
  const raw = brief == null ? '' : String(brief);
  const normText = normalizeVi(raw);
  const domainLexicon = buildDomainLexicon(registry);

  const domains = [];
  for (const [id, phrases] of [...domainLexicon.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hits = collectHits(normText, raw, phrases);
    if (hits.length) {
      domains.push({ id, hits, strength: hits.length, longest: hits[0].keyword.length });
    }
  }
  // Primary domain = most distinct phrases, then the most specific (longest) phrase, then id.
  //
  // …except a SUBORDINATE domain never outranks a more specific one (taxonomy
  // `subordinateDomains`). Two different reasons, same handling:
  //   campaign.loyalty  — a feature layer (points, vouchers, minigames) sitting on top of some
  //                       industry; it is the subject of the app only when no industry is named.
  //   commerce.general  — defined as "bán lẻ nói chung, chưa rõ ngành hàng", so by construction
  //                       it cannot rank alongside commerce.fashion or commerce.grocery.
  // Measured 2026-08-23 without this rule: "app cà phê có tích điểm thành viên" scored
  // zaui-lucky-wheel above zaui-coffee, and "bán đồng phục bác sĩ" tied zaui-shop with
  // zaui-fashion and fell back to lab.
  const subordinate = new Set(taxonomy.subordinateDomains ?? []);
  const hasSpecificDomain = domains.some((d) => !subordinate.has(d.id));
  const rank = (d) => (hasSpecificDomain && subordinate.has(d.id) ? 1 : 0);
  domains.sort((a, b) => rank(a) - rank(b)
    || b.strength - a.strength || b.longest - a.longest || a.id.localeCompare(b.id));

  // SIBLING domains tied on evidence strength are ALL primary. Ranking fnb.restaurant 4 and
  // fnb.coffee 10 because "đồ uống" is two characters longer than "đồ ăn" is an implementation
  // artifact, not a signal — and that manufactured 6-point margin was enough to push
  // "làm app bán đồ ăn đồ uống" into auto-select instead of asking.
  //
  // Restricted to siblings (same family prefix, `fnb.*`) on purpose. ACROSS families the more
  // specific industry legitimately wins: "coffee shop" hits fnb.coffee and commerce.general with
  // one phrase each, but that is one noun phrase naming one business, not two competing claims —
  // treating it as a tie handed zaui-shop a full primary-domain score.
  const familyOf = (id) => String(id).split('.')[0];
  const topRank = domains.length ? rank(domains[0]) : 0;
  const topStrength = domains.length ? domains[0].strength : 0;
  const topFamily = domains.length ? familyOf(domains[0].id) : null;
  const primaryDomainIds = domains
    .filter((d) => rank(d) === topRank && d.strength === topStrength && familyOf(d.id) === topFamily)
    .map((d) => d.id);

  const phrasesFor = (id, table, descriptions) => {
    const desc = descriptions?.[id];
    return [...(table[id] ?? []), ...(desc ? [desc] : [])];
  };
  const jobs = [];
  for (const id of Object.keys(taxonomy.jobs ?? {})) {
    const hits = collectHits(normText, raw, phrasesFor(id, JOB_PHRASES, taxonomy.jobs));
    if (hits.length) jobs.push({ id, hits });
  }
  const capabilities = [];
  for (const id of Object.keys(taxonomy.capabilities ?? {})) {
    const hits = collectHits(normText, raw, phrasesFor(id, CAPABILITY_PHRASES, taxonomy.capabilities));
    if (hits.length) capabilities.push({ id, hits });
  }
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  capabilities.sort((a, b) => a.id.localeCompare(b.id));

  return {
    normalized: normText,
    primaryDomain: domains[0]?.id ?? null,
    // Every domain that scores at the primary weight — usually one, more when the brief gives
    // two industries exactly the same evidence.
    primaryDomainIds,
    domains,
    jobs,
    capabilities,
    // KHÔNG còn là gate (plan 34 D34-1) — chỉ là tín hiệu ý định: nếu user đã nói rõ muốn
    // dùng mẫu có sẵn thì nhánh lab-fallback phải chuyển thành câu hỏi thay vì im lặng.
    optInRequested: optInPhrases().some((ph) => matchNormalized(normText, ph)),
    taxonomyVersion: taxonomy.version ?? null,
  };
}

// Cues that turn a product name in prose into an instruction ("dùng mmenu…", "set up the mmenu
// template…"). Without one, a bare name is just a word: "menu", "shop" and "restaurant" are all
// template names AND ordinary vocabulary, and treating every mention as a command would make the
// ranker ask a question on almost every brief.
const USE_CUES = Object.freeze(['dùng', 'sử dụng', 'xài', 'use', 'set up', 'template', 'mẫu']);

/**
 * Does the brief name THIS template as a product, with an instruction cue?
 * The name is the registry id minus the `zaui-` prefix (separators normalized), which is exactly
 * the string a user types: "mmenu", "lucky wheel", "egovernment".
 */
export function briefNamesTemplate(intent, profile) {
  const bare = String(profile.id).replace(/^zaui-/, '').replace(/[-_]+/g, ' ').trim();
  if (bare.length < 4) return false;                       // too short to be distinctive
  if (!matchNormalized(intent.normalized, bare)) return false;
  return USE_CUES.some((cue) => matchNormalized(intent.normalized, cue));
}

// --- Hard filter (runs BEFORE scoring is allowed to decide anything) -------------------
// CONTRACT-plan34 rule 2. Returns null when the profile may be auto-scaffolded, else the
// reason string that goes into alternatives[].rejectedBecause.
export function hardFilterReason(profile, { providedInputs = [] } = {}) {
  const q = profile.qualification ?? {};
  const s = profile.source ?? {};
  if (!AUTO_SCAFFOLD_STATES.includes(q.state)) {
    return `chưa đạt bậc tối thiểu để auto-scaffold (state=${q.state ?? 'unknown'}, cần ≥ render-qualified)`;
  }
  if (!s.revision) {
    return 'không có revision immutable đã pin trong registry';
  }
  if (q.testedRevision !== s.revision) {
    return `qualification evidence lệch revision (tested=${q.testedRevision ?? 'null'} vs pinned=${s.revision})`;
  }
  if (s.licenseDecision === 'review-required' && !LICENSE_GRANDFATHERED.includes(profile.id)) {
    return 'licenseDecision=review-required — chờ quyết định owner (D34-8) trước khi được auto-scaffold';
  }
  const missing = (profile.constraints?.requiredInputs ?? []).filter((k) => !providedInputs.includes(k));
  if (missing.length) {
    return `thiếu input bắt buộc cho preview đầu tiên: ${missing.join(', ')}`;
  }
  if (profile.constraints?.backendRequiredForPreview === true) {
    return 'cần backend riêng mới render được preview đầu tiên';
  }
  return null;
}

// --- Scoring ---------------------------------------------------------------------------
function scoreProfile(profile, intent, opts) {
  const reasons = [];
  const evidence = [];
  let score = 0;

  let matchedSignals = 0;
  let domainScoreHits = 0;

  const declaredDomains = profile.intent?.domains ?? [];
  // A domain scores the primary weight when it is in the primary TIER — normally one domain,
  // more when the brief gives two sibling domains identical evidence (see extractIntent).
  const primaryIds = new Set(intent.primaryDomainIds ?? (intent.primaryDomain ? [intent.primaryDomain] : []));
  for (const d of intent.domains) {
    if (!declaredDomains.includes(d.id)) continue;
    matchedSignals++;
    domainScoreHits++;
    const primary = primaryIds.has(d.id);
    const w = primary ? WEIGHTS.domainPrimary : WEIGHTS.domainSecondary;
    score += w;
    reasons.push(`domain${primary ? '' : '-secondary'}:${d.id} ${fmt(w)} (brief: ${quote(d.hits)})`);
    for (const h of d.hits) evidence.push(h.span);
  }

  const declaredJobs = profile.intent?.jobs ?? [];
  const jobHits = intent.jobs.filter((j) => declaredJobs.includes(j.id)).slice(0, HIT_CAPS.job);
  for (const j of jobHits) {
    matchedSignals++;
    score += WEIGHTS.job;
    reasons.push(`job:${j.id} ${fmt(WEIGHTS.job)} (brief: ${quote(j.hits)})`);
    evidence.push(j.hits[0].span);
  }

  const declaredCaps = profile.capabilities ?? [];
  const capHits = intent.capabilities.filter((c) => declaredCaps.includes(c.id)).slice(0, HIT_CAPS.capability);
  for (const c of capHits) {
    matchedSignals++;
    score += WEIGHTS.capability;
    reasons.push(`capability:${c.id} ${fmt(WEIGHTS.capability)} (brief: ${quote(c.hits)})`);
  }

  const aliasHits = collectHits(
    intent.normalized,
    opts.rawBrief,
    [...(profile.intent?.aliases ?? []), ...(profile.intent?.audiences ?? [])]
  ).slice(0, HIT_CAPS.alias);
  for (const a of aliasHits) {
    matchedSignals++;
    score += WEIGHTS.aliasHit;
    reasons.push(`alias:"${a.span}" ${fmt(WEIGHTS.aliasHit)}`);
    evidence.push(a.span);
  }

  // Negative signals: strong enough to flip a decision, not just shave it. 'bán đồng phục
  // bác sĩ' must not land on a clinic template even though 'bác sĩ' matches its alias.
  const negativeHits = collectHits(intent.normalized, opts.rawBrief, profile.intent?.negativeSignals ?? []);
  for (const n of negativeHits) {
    score += WEIGHTS.negativeSignal;
    reasons.push(`negative-signal:"${n.span}" ${fmt(WEIGHTS.negativeSignal)} (veto)`);
  }

  // Preview-readiness / input constraints — scored as well as hard-filtered, so a
  // constrained template never outranks a clean sibling inside a choice.
  const missingInputs = (profile.constraints?.requiredInputs ?? [])
    .filter((k) => !(opts.providedInputs ?? []).includes(k));
  if (missingInputs.length || profile.constraints?.backendRequiredForPreview === true) {
    score += WEIGHTS.constraintUnmet;
    reasons.push(
      `preview-readiness ${fmt(WEIGHTS.constraintUnmet)} (${
        missingInputs.length ? `thiếu ${missingInputs.join(', ')}` : 'cần backend riêng'
      })`
    );
  }

  const rejectedBecause = hardFilterReason(profile, opts);
  if (rejectedBecause) reasons.push(`hard-filter: ${rejectedBecause}`);

  return {
    id: profile.id,
    profile,
    score: round2(score),
    reasons,
    evidence: dedupe(evidence),
    // Did anything in the brief actually point at this template? A profile that only picked
    // up its own constraint penalty is not a candidate and must not clutter alternatives[].
    matched: matchedSignals > 0 || negativeHits.length > 0,
    // Có khớp domain của chính template này không (không tính job/capability đi ké).
    domainMatched: domainScoreHits > 0,
    vetoed: negativeHits.length > 0,
    eligible: !rejectedBecause && negativeHits.length === 0,
    // Veto first: when a brief hits a negative signal that is THE reason this template is
    // wrong for it, even if the support gate would also have stopped it.
    rejectedBecause: negativeHits.length
      ? `negative signal trong brief: "${negativeHits[0].span}"${rejectedBecause ? `; ngoài ra ${rejectedBecause}` : ''}`
      : rejectedBecause,
    state: profile.qualification?.state ?? 'unknown',
  };
}

function fmt(n) {
  return n > 0 ? `+${n}` : String(n);
}
function quote(hits) {
  return hits.map((h) => `"${h.span}"`).join(', ');
}
function dedupe(list) {
  return [...new Set(list)];
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function differentFlows(a, b) {
  return jaccard(a.profile.intent?.jobs ?? [], b.profile.intent?.jobs ?? []) <= DIFFERENT_FLOW_MAX_JACCARD;
}

// --- Choice options --------------------------------------------------------------------
// `why` must state the useful difference, not repeat the id: the jobs THIS option has that
// the others do not, described with the taxonomy's own wording, plus the support state when
// the option cannot be scaffolded today.
function buildOptions(tier, taxonomy) {
  return tier.map((cand) => {
    const mine = cand.profile.intent?.jobs ?? [];
    const others = new Set(tier.filter((o) => o.id !== cand.id).flatMap((o) => o.profile.intent?.jobs ?? []));
    const unique = mine.filter((j) => !others.has(j));
    const described = (unique.length ? unique : mine)
      .slice(0, 3)
      .map((j) => taxonomy.jobs?.[j] ?? j);
    const parts = [];
    if (described.length) parts.push(`${unique.length ? 'Khác biệt' : 'Bao gồm'}: ${described.join('; ')}`);
    for (const a of (cand.profile.intent?.audiences ?? []).slice(0, 1)) parts.push(`hợp với ${a}`);
    if (!cand.eligible && cand.rejectedBecause) parts.push(`LƯU Ý: ${cand.rejectedBecause}`);
    return { id: cand.id, why: parts.join(' — '), jobs: mine };
  });
}

// --- Decision ---------------------------------------------------------------------------
function baseSelection(registry, intent) {
  return {
    schemaVersion: 1,
    mode: 'lab',
    selectedId: null,
    revision: null,
    confidence: null,
    score: null,
    margin: null,
    reasons: [],
    evidence: [],
    alternatives: [],
    registryVersion: registry.registryVersion ?? 'unknown',
    taxonomyVersion: intent?.taxonomyVersion ?? registry.taxonomyVersion ?? null,
  };
}

function alternativesOf(candidates, limit = 5) {
  return candidates.slice(0, limit).map((c) => ({
    id: c.id,
    score: c.score,
    state: c.state,
    rejectedBecause: c.rejectedBecause,
  }));
}

/** `--template <giá trị lạ>`: caller map sang exit 3 (config error), không phải needs_input. */
export class InvalidTemplateArg extends Error {
  constructor(value, ids) {
    super(`invalid --template "${value}" — hợp lệ: auto | lab | official:<id> (ids: ${ids.join(', ')})`);
    this.name = 'InvalidTemplateArg';
    this.value = value;
  }
}

/**
 * Full ranker output. `selection` alone is the schema-valid part written to input.json.
 */
export function rankTemplates(brief, opts = {}) {
  const registry = opts.registry ?? loadRegistry();
  const taxonomy = opts.taxonomy ?? loadTaxonomy();
  assertLexiconIds(taxonomy);
  const providedInputs = opts.providedInputs ?? [];
  const rawBrief = brief == null ? '' : String(brief);
  const requested = (opts.template ?? 'auto').trim();
  // Giá trị lạ phải dừng, không được im lặng thành auto: `--template coffee` (thiếu prefix)
  // mà chạy như auto thì user tưởng đã ghim template trong khi ranker tự chọn cái khác.
  if (requested !== 'auto' && requested !== 'lab' && !/^official:.+$/.test(requested)) {
    throw new InvalidTemplateArg(requested, (registry.templates ?? []).map((t) => t.id));
  }

  const intent = extractIntent(rawBrief, { registry, taxonomy });
  const selection = baseSelection(registry, intent);
  const byId = new Map((registry.templates ?? []).map((t) => [t.id, t]));

  // 1. --template lab: forced, no recommendation at all.
  if (requested === 'lab') {
    selection.mode = 'lab';
    selection.reasons = ['--template lab: user ép dùng lab shell, không chạy ranker'];
    return { selection, templateOptions: [], blocked: null, candidates: [], intent };
  }

  // 2. --template official:<id>: absolute priority, but never bypasses the support gate.
  const explicitMatch = /^official:(.+)$/.exec(requested);
  if (explicitMatch) {
    const id = explicitMatch[1].trim();
    const profile = byId.get(id);
    if (!profile) {
      // Dừng rõ ràng: mode 'explicit' + revision null. Trả selection mặc định (lab) ở đây sẽ
      // khiến consumer tưởng là fallback hợp lệ và scaffold lab, trong khi user chỉ đích danh
      // một id không tồn tại — phải báo lỗi và liệt kê id hợp lệ.
      selection.mode = 'explicit';
      // selectedId chỉ được mang id CÓ THẬT trong registry; id không tồn tại đi qua `blocked`.
      selection.selectedId = null;
      selection.revision = null;
      selection.confidence = 'high';
      selection.reasons = [
        `explicit: user chỉ đích danh --template official:${id}`,
        `unknown template id "${id}" — dừng trước mọi fetch/mutation, không fallback sang lab`,
      ];
      return {
        selection,
        templateOptions: [],
        blocked: { id, reason: `unknown template id "${id}"`, kind: 'unknown', supported: supportedIds(registry, providedInputs) },
        candidates: [],
        intent,
      };
    }
    const rejectedBecause = hardFilterReason(profile, { providedInputs });
    selection.mode = 'explicit';
    selection.selectedId = id;
    selection.revision = rejectedBecause ? null : profile.source?.revision ?? null;
    selection.confidence = 'high';
    selection.reasons = [
      `explicit: user chỉ đích danh --template official:${id}`,
      rejectedBecause
        ? `hard-filter: ${rejectedBecause} — dừng trước mọi fetch/mutation`
        : `hard-filter: pass (state=${profile.qualification?.state}, revision=${profile.source?.revision})`,
    ];
    selection.alternatives = [{
      id,
      score: 0,
      state: profile.qualification?.state ?? 'unknown',
      rejectedBecause: rejectedBecause ?? null,
    }];
    const blocked = rejectedBecause
      ? { id, reason: rejectedBecause, kind: 'unsupported', supported: supportedIds(registry, providedInputs) }
      : null;
    return { selection, templateOptions: [], blocked, candidates: [], intent };
  }

  // 3. auto: score everything, then apply the decision table.
  const scored = (registry.templates ?? [])
    .map((p) => scoreProfile(p, intent, { rawBrief, providedInputs }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const semantic = scored.filter((c) => c.score > 0 && !c.vetoed
    && (!intent.primaryDomain || c.domainMatched));
  const eligible = semantic.filter((c) => c.eligible);
  // Ranking is SEMANTIC; the hard filter decides what can be acted on, and the two must not be
  // collapsed. Until 2026-08-23 the tier was `eligible.length ? eligible : semantic`, so as soon
  // as one template in a domain got qualified every better-matching-but-unqualified rival
  // vanished from the margin computation — and the report then claimed a huge margin for a weaker match.
  // Measured the day zaui-bistro was promoted: "app đặt bàn trước cho nhà hàng" scored
  // zaui-restaurant 17 (it is the only template declaring job table.reserve) and zaui-bistro 10,
  // and the ranker auto-selected bistro "margin 10" — a template with no table booking at all.
  // Same shape broke DoD #3 ("app nhà hàng" must ask one classifying question).
  //
  // The tier is therefore every semantic candidate. Eligibility comes back in below, where it
  // belongs: 3a only asks when at least one option in the tier is actionable today, and 3b
  // refuses to substitute a different template when the best match itself cannot be built.
  const tierAll = semantic;

  if (!tierAll.length) {
    selection.mode = 'lab';
    selection.evidence = dedupe(intent.domains.flatMap((d) => d.hits.map((h) => h.span)));
    selection.alternatives = alternativesOf(scored.filter((c) => c.matched));
    selection.reasons = [
      intent.primaryDomain
        ? `không còn ứng viên nào sau negative-signal/hard-filter cho domain ${intent.primaryDomain}`
        : 'không match domain nào trong registry — không có official template phù hợp',
      'lab shell: dựng theo brief, không ép vào template sai domain',
    ];
    return { selection, templateOptions: [], blocked: null, candidates: scored, intent };
  }

  const top = tierAll[0];
  const margin = round2(top.score - (tierAll[1]?.score ?? 0));
  const contenders = tierAll.filter((c) => c.id === top.id || top.score - c.score < AUTO_SELECT_MIN_MARGIN);
  const rivals = contenders.filter((c) => c.id !== top.id && differentFlows(top, c));

  selection.score = top.score;
  selection.margin = margin;
  selection.evidence = top.evidence;
  selection.alternatives = alternativesOf(scored.filter((c) => c.matched));

  // 3a. Genuine ambiguity: near-tie between two different product flows → one question.
  // Cùng điều kiện domain evidence như 3c: hỏi "phòng khám hay thời trang?" khi brief không hề
  // nói ngành là đẩy user chọn giữa hai phỏng đoán, không phải làm rõ ý định. Brief chỉ khớp
  // job/capability đi thẳng 3d (lab + alternatives) để agent nói rõ còn thiếu gì.
  const tierSelectable = [top, ...rivals].some((c) => c.eligible);
  if (intent.primaryDomain && rivals.length && tierSelectable) {
    const tier = [top, ...rivals].slice(0, 3);
    selection.mode = 'choice';
    selection.selectedId = null;
    selection.confidence = 'medium';
    selection.reasons = [
      ...top.reasons,
      `choice: ${tier.map((c) => `${c.id}=${c.score}`).join(', ')} nằm trong margin ${AUTO_SELECT_MIN_MARGIN} và là các product flow khác nhau`,
      `ít nhất một lựa chọn scaffold được ngay (${tier.filter((c) => c.eligible).map((c) => c.id).join(', ') || '—'}); hỏi một câu để chốt hướng`,
    ];
    return { selection, templateOptions: buildOptions(tier, taxonomy), blocked: null, candidates: scored, intent };
  }

  // 3b. The best semantic match itself cannot be built today. Never silently substitute a
  // lower-scoring template that happens to be qualified — say which one fits and why it is
  // blocked, then fall back to the lab shell (or ask, when the user explicitly wanted a
  // template).
  if (!top.eligible) {
    if (intent.optInRequested) {
      // User nói rõ "dùng mẫu có sẵn": im lặng dựng lab là bỏ qua ý định của họ.
      const tier = [top, ...tierAll.filter((c) => c.id !== top.id)].slice(0, 3);
      selection.mode = 'choice';
      selection.selectedId = null;
      selection.confidence = 'medium';
      selection.score = top.score;
      selection.alternatives = alternativesOf(scored.filter((c) => c.matched));
      selection.reasons = [
        ...top.reasons,
        `user yêu cầu dùng mẫu có sẵn nhưng ${top.id} ${top.rejectedBecause}`,
        'không tự rơi về lab khi user đã chỉ định muốn dùng mẫu — hỏi để user chốt',
      ];
      return { selection, templateOptions: buildOptions(tier, taxonomy), blocked: null, candidates: scored, intent };
    }
    selection.mode = 'lab';
    selection.selectedId = null;
    selection.score = null;
    selection.margin = null;
    selection.confidence = null;
    selection.reasons = [
      `ứng viên ngữ nghĩa tốt nhất: ${top.id} (score ${top.score}) — ${top.rejectedBecause}`,
      ...top.reasons,
      'không thay bằng template khác domain; dùng lab shell và báo rõ lý do',
    ];
    return { selection, templateOptions: [], blocked: null, candidates: scored, intent };
  }

  // 3b-bis. The brief NAMES a template that cannot be built today.
  //
  // `--template official:<id>` is the command channel and already stops before any mutation. But
  // a user can also name a product in prose — "dùng mmenu làm app gọi món cho chuỗi trà sữa" —
  // and silently scaffolding zaui-coffee instead answers a question they did not ask. Say what
  // is wrong with the one they named, and offer the buildable alternative as a choice.
  //
  // Deliberately narrow, because a bare product name is a common word ("shop", "menu",
  // "restaurant"): the brief must contain the template's OWN name AND a use-cue.
  const namedBlocked = scored.filter((c) => !c.eligible && briefNamesTemplate(intent, c.profile));
  if (namedBlocked.length && !namedBlocked.some((c) => c.id === top.id)) {
    const tier = [...namedBlocked, top].slice(0, 3);
    selection.mode = 'choice';
    selection.selectedId = null;
    selection.confidence = 'medium';
    selection.reasons = [
      ...namedBlocked.map((c) => `brief gọi đích danh "${c.id}" nhưng ${c.rejectedBecause}`),
      `không tự đổi sang ${top.id}: user đã nêu tên template cụ thể, đổi thầm là trả lời một câu hỏi khác`,
      `${top.id} dựng được ngay và có thể là lựa chọn thay thế — hỏi một câu để user chốt`,
    ];
    return { selection, templateOptions: buildOptions(tier, taxonomy), blocked: null, candidates: scored, intent };
  }

  // 3c. Auto-select. Bắt buộc có domain evidence: điểm gom từ job/capability không đủ để tự
  // scaffold, vì cùng một job có ở nhiều ngành (appointment.booking có cả ở phòng khám lẫn dịch
  // vụ công) nên chọn theo job là đoán ngành. Đúng rationale AUTO_SELECT_MIN_SCORE ở đầu file.
  if (intent.primaryDomain && top.score >= AUTO_SELECT_MIN_SCORE && margin >= AUTO_SELECT_MIN_MARGIN) {
    selection.mode = 'auto';
    selection.selectedId = top.id;
    selection.revision = top.profile.source?.revision ?? null;
    selection.confidence =
      top.score >= AUTO_SELECT_MIN_SCORE + 2 && margin >= AUTO_SELECT_MIN_MARGIN * 2 ? 'high' : 'medium';
    selection.reasons = [
      ...top.reasons,
      `auto-select: score ${top.score} ≥ ${AUTO_SELECT_MIN_SCORE} và margin ${margin} ≥ ${AUTO_SELECT_MIN_MARGIN}`,
      `revision đã pin: ${selection.revision}`,
    ];
    return { selection, templateOptions: [], blocked: null, candidates: scored, intent };
  }

  // 3d. Eligible but under threshold: weak evidence is not a licence to scaffold.
  selection.mode = 'lab';
  selection.selectedId = null;
  selection.confidence = null;
  selection.reasons = [
    ...top.reasons,
    intent.primaryDomain
      ? `dưới ngưỡng auto-select: score ${top.score} (cần ≥ ${AUTO_SELECT_MIN_SCORE}), margin ${margin} (cần ≥ ${AUTO_SELECT_MIN_MARGIN})`
      : `thiếu domain evidence: brief chỉ khớp job/capability (score ${top.score}) nên không đủ căn cứ chọn ngành`,
    'lab shell: bằng chứng chưa đủ mạnh để tự chọn template',
  ];
  return { selection, templateOptions: [], blocked: null, candidates: scored, intent };
}

export function supportedIds(registry, providedInputs = []) {
  return (registry.templates ?? [])
    .filter((p) => hardFilterReason(p, { providedInputs }) === null)
    .map((p) => p.id);
}

/** Schema-valid templateSelection for a brief (schemas/template-selection.schema.json). */
export function recommend(brief, opts = {}) {
  return rankTemplates(brief, opts).selection;
}

// --- CLI ---------------------------------------------------------------------------------
// Default output is EXACTLY the templateSelection (schema-valid, copy-pasteable into a
// validator). --verbose adds the parts that live outside that schema: choice options, the
// explicit block, the extracted intent and every candidate's score breakdown.
function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const brief = getArg(argv, 'brief', null);
  if (brief === null) {
    process.stderr.write('recommend-template: --brief "<text>" is required\n');
    process.exit(3);
  }
  const opts = { template: getArg(argv, 'template', 'auto') };
  const registryFile = getArg(argv, 'registry', null);
  const taxonomyFile = getArg(argv, 'taxonomy', null);
  if (registryFile) opts.registry = loadRegistry(registryFile);
  if (taxonomyFile) opts.taxonomy = loadTaxonomy(taxonomyFile);
  let out;
  try {
    out = rankTemplates(brief, opts);
  } catch (e) {
    if (!(e instanceof InvalidTemplateArg)) throw e;
    process.stderr.write(`recommend-template: ${e.message}\n`);
    process.exit(3);
  }
  const payload = argv.includes('--verbose')
    ? {
        selection: out.selection,
        templateOptions: out.templateOptions,
        blocked: out.blocked,
        intent: {
          primaryDomain: out.intent.primaryDomain,
          domains: out.intent.domains.map((d) => ({ id: d.id, evidence: d.hits.map((h) => h.span) })),
          jobs: out.intent.jobs.map((j) => ({ id: j.id, evidence: j.hits.map((h) => h.span) })),
          capabilities: out.intent.capabilities.map((c) => ({ id: c.id, evidence: c.hits.map((h) => h.span) })),
        },
        candidates: out.candidates.map((c) => ({ id: c.id, score: c.score, eligible: c.eligible, reasons: c.reasons })),
      }
    : out.selection;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}
