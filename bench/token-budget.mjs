#!/usr/bin/env node
// bench/token-budget.mjs — đo "trọng lượng context" tĩnh của skill theo release.
// Tooling dev ở root repo — KHÔNG thuộc bộ skill release, agent không bao giờ nạp file này.
//
// Ba tầng chi phí token của skill đối với agent:
//   tax      — frontmatter `description` trong SKILL.md: nằm trong system prompt của MỌI
//              session có cài plugin, kể cả khi không dùng skill.
//   trigger  — toàn bộ SKILL.md: nạp khi skill được invoke.
//   ondemand — references/* + schemas/* + config.json: chỉ tốn khi agent mở từng file.
//
// Mặc định dùng ước lượng offline (length/3.4). Số tuyệt đối là xấp xỉ, nhưng CÙNG một
// estimator ở cả hai ref nên DELTA giữa hai release là so sánh được. `--api` gọi
// /v1/messages/count_tokens (cần ANTHROPIC_API_KEY, tôn trọng ANTHROPIC_BASE_URL) khi cần
// số tuyệt đối chính xác theo tokenizer thật.
//
// Usage:
//   node bench/token-budget.mjs                        # bảng cho working tree (HEAD hiện tại)
//   node bench/token-budget.mjs --compare v0.4.1       # working tree vs ref (tag/commit)
//   node bench/token-budget.mjs --compare v0.4.1 --json
//   node bench/token-budget.mjs --api                  # đếm chính xác qua API
//   node bench/token-budget.mjs --record [--note "…"]  # ghi/refresh row version hiện tại vào
//                                                      # bench/HISTORY.md (sổ theo dõi, tracked;
//                                                      # release-gate enforce row này khớp số)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKILL = 'skill/create-zmp-app';
const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : null;
};
const compareRef = typeof getArg('compare') === 'string' ? getArg('compare') : null;
const asJson = argv.includes('--json');
const useApi = argv.includes('--api');
const doRecord = argv.includes('--record');
const recordNote = typeof getArg('note') === 'string' ? getArg('note') : '';
if (doRecord && useApi) {
  console.error('--record chỉ dùng estimator offline (giữ số nhất quán với check của release-gate)');
  process.exit(3);
}

const estimate = (text) => Math.ceil(text.length / 3.4);

async function countApi(text) {
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('--api cần ANTHROPIC_API_KEY');
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.BENCH_COUNT_MODEL || 'claude-opus-5',
      messages: [{ role: 'user', content: text || ' ' }],
    }),
  });
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).input_tokens;
}

const count = async (text) => (useApi ? countApi(text) : estimate(text));

// ---- đọc file từ working tree hoặc từ một git ref ----
function readTree(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}
function readRef(ref, rel) {
  return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
function listTree(dirRel, exts) {
  const dir = path.join(REPO, dirRel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e))).map((f) => `${dirRel}/${f}`);
}
function listRef(ref, dirRel, exts) {
  let out;
  try {
    out = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, dirRel], { cwd: REPO, encoding: 'utf8' });
  } catch {
    return [];
  }
  return out.split('\n').filter((f) => f && exts.some((e) => f.endsWith(e)));
}

function extractDescription(skillMd) {
  const m = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return '';
  const fm = m[1];
  const d = fm.match(/^description:\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:|$)/m);
  return d ? d[1].trim() : '';
}

// snapshot(ref = null → working tree) → { files: [{rel, group, tokens, bytes}] }
async function snapshot(ref) {
  const read = ref ? (rel) => readRef(ref, rel) : readTree;
  const list = ref ? (d, e) => listRef(ref, d, e) : listTree;
  const files = [];
  const add = async (rel, group, contentOverride) => {
    let content;
    try {
      content = contentOverride ?? read(rel);
    } catch {
      return; // file không tồn tại ở ref đó
    }
    files.push({ rel, group, bytes: Buffer.byteLength(content), tokens: await count(content) });
  };

  const skillMd = read(`${SKILL}/SKILL.md`);
  await add(`${SKILL}/SKILL.md#description`, 'tax', extractDescription(skillMd));
  await add(`${SKILL}/SKILL.md`, 'trigger', skillMd);
  for (const rel of list(`${SKILL}/references`, ['.md', '.json'])) await add(rel, 'ondemand');
  for (const rel of list(`${SKILL}/schemas`, ['.json'])) await add(rel, 'ondemand');
  await add(`${SKILL}/config.json`, 'ondemand');
  return { files };
}

function totals(snap) {
  const t = { tax: 0, trigger: 0, ondemand: 0 };
  for (const f of snap.files) t[f.group] += f.tokens;
  return t;
}

const fmt = (n) => n.toLocaleString('en-US');
const delta = (a, b) => {
  const d = a - b;
  const pct = b > 0 ? ` (${d >= 0 ? '+' : ''}${((d / b) * 100).toFixed(1)}%)` : '';
  return `${d >= 0 ? '+' : ''}${fmt(d)}${pct}`;
};

const cur = await snapshot(null);
const base = compareRef ? await snapshot(compareRef) : null;

if (doRecord) {
  const t = totals(cur);
  const version = JSON.parse(readTree(`${SKILL}/package.json`)).version;
  const histPath = path.join(REPO, 'bench', 'HISTORY.md');
  const lines = fs.readFileSync(histPath, 'utf8').split('\n');
  const isRow = (l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l);
  const kept = lines.filter((l) => !(isRow(l) && l.split('|')[2].trim() === version));
  const prevRow = [...kept].reverse().find(isRow) ?? null;
  const dRec = (curV, oldV) => {
    if (oldV === null) return '—';
    const d = curV - oldV;
    return `${d >= 0 ? '+' : ''}${d}${oldV > 0 ? ` (${d >= 0 ? '+' : ''}${((d / oldV) * 100).toFixed(1)}%)` : ''}`;
  };
  const prev = prevRow
    ? { trigger: Number(prevRow.split('|')[4]), ondemand: Number(prevRow.split('|')[5]) }
    : { trigger: null, ondemand: null };
  const today = new Date().toISOString().slice(0, 10);
  const row = `| ${today} | ${version} | ${t.tax} | ${t.trigger} | ${t.ondemand} | ${dRec(t.trigger, prev.trigger)} | ${dRec(t.ondemand, prev.ondemand)} | ${recordNote || '—'} |`;
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  kept.push(row, '');
  fs.writeFileSync(histPath, kept.join('\n'));
  console.log(`Đã ghi bench/HISTORY.md:\n${row}`);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ mode: useApi ? 'api-exact' : 'estimate', compareRef, totals: totals(cur), current: cur, base }, null, 2));
  process.exit(0);
}

const mode = useApi ? 'API count_tokens (chính xác)' : 'ước lượng offline (length/3.4) — delta tin được, số tuyệt đối xấp xỉ';
console.log(`# Token budget — ${SKILL}\nMode: ${mode}\n`);

const curT = totals(cur);
if (!base) {
  console.log(`tax (description, mọi session): ${fmt(curT.tax)}`);
  console.log(`trigger (SKILL.md khi invoke) : ${fmt(curT.trigger)}`);
  console.log(`ondemand (refs/schemas/config): ${fmt(curT.ondemand)}\n`);
  for (const f of [...cur.files].sort((a, b) => b.tokens - a.tokens)) {
    console.log(`${String(f.tokens).padStart(8)}  ${f.group.padEnd(8)}  ${f.rel}`);
  }
} else {
  const baseT = totals(base);
  console.log(`So với ref: ${compareRef}\n`);
  for (const g of ['tax', 'trigger', 'ondemand']) {
    console.log(`${g.padEnd(8)}: ${fmt(baseT[g])} → ${fmt(curT[g])}   ${delta(curT[g], baseT[g])}`);
  }
  const baseMap = new Map(base.files.map((f) => [f.rel, f]));
  const curMap = new Map(cur.files.map((f) => [f.rel, f]));
  const rows = [];
  for (const [rel, f] of curMap) {
    const b = baseMap.get(rel);
    rows.push({ rel, group: f.group, from: b ? b.tokens : 0, to: f.tokens, tag: b ? '' : ' [MỚI]' });
  }
  for (const [rel, b] of baseMap) {
    if (!curMap.has(rel)) rows.push({ rel, group: b.group, from: b.tokens, to: 0, tag: ' [XOÁ]' });
  }
  rows.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  console.log('\nFile thay đổi nhiều nhất:');
  for (const r of rows.filter((r) => r.to !== r.from).slice(0, 15)) {
    console.log(`  ${delta(r.to, r.from).padStart(16)}  ${r.rel}${r.tag}`);
  }
}
