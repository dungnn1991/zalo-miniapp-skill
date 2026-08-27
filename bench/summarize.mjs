#!/usr/bin/env node
// bench/summarize.mjs — tổng hợp kết quả bench-agent.sh thành bảng so sánh.
// Usage: node bench/summarize.mjs <label> [<labelCũ>]
//
// Mỗi run: volume = input + cache_read + cache_creation (tổng context xử lý — bền với trạng
// thái cache nên là số dùng để SO SÁNH GIỮA RELEASE); regime = cold (cache_creation >
// cache_read) hay warm; run is_error hoặc thiếu usage bị loại và liệt kê riêng.
// Median lấy trên các run hợp lệ.

import fs from 'node:fs';
import path from 'node:path';

const [labelA, labelB] = process.argv.slice(2);
if (!labelA) {
  console.error('usage: node bench/summarize.mjs <label> [<labelCũ>]');
  process.exit(3);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));

function load(label) {
  const dir = path.join(ROOT, 'results', label);
  if (!fs.existsSync(dir)) {
    console.error(`không có bench/results/${label}`);
    process.exit(3);
  }
  const byScenario = new Map();
  const rejected = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(.+)__run(\d+)\.json$/);
    if (!m) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      rejected.push(`${f}: JSON hỏng`);
      continue;
    }
    const u = j.usage;
    if (j.is_error || !u || typeof u.input_tokens !== 'number') {
      rejected.push(`${f}: is_error=${j.is_error ?? '?'} subtype=${j.subtype ?? '?'}`);
      continue;
    }
    const run = {
      volume: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      out: u.output_tokens ?? 0,
      turns: j.num_turns ?? 0,
      cost: j.total_cost_usd ?? 0,
      regime: (u.cache_creation_input_tokens ?? 0) > (u.cache_read_input_tokens ?? 0) ? 'cold' : 'warm',
    };
    if (!byScenario.has(m[1])) byScenario.set(m[1], []);
    byScenario.get(m[1]).push(run);
  }
  return { byScenario, rejected };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');

function summary(label) {
  const { byScenario, rejected } = load(label);
  const rows = new Map();
  for (const [id, runs] of byScenario) {
    rows.set(id, {
      n: runs.length,
      volume: median(runs.map((r) => r.volume)),
      out: median(runs.map((r) => r.out)),
      turns: median(runs.map((r) => r.turns)),
      cost: median(runs.map((r) => r.cost)),
      regimes: runs.map((r) => r.regime).join(','),
    });
  }
  return { rows, rejected };
}

const A = summary(labelA);
const B = labelB ? summary(labelB) : null;

console.log(`# Bench summary — ${labelA}${labelB ? ` vs ${labelB}` : ''} (median trên các run hợp lệ)\n`);
for (const [id, a] of A.rows) {
  const b = B?.rows.get(id);
  const d = (cur, old, dec = 0) =>
    old === undefined ? cur.toFixed(dec) : `${old.toFixed(dec)} → ${cur.toFixed(dec)} (${cur >= old ? '+' : ''}${(cur - old).toFixed(dec)})`;
  console.log(`## ${id}  (n=${a.n}${b ? ` vs n=${b.n}` : ''}; regime: ${a.regimes})`);
  console.log(`  volume  : ${b ? `${fmt(b.volume)} → ` : ''}${fmt(a.volume)}${b ? ` (${a.volume >= b.volume ? '+' : ''}${fmt(a.volume - b.volume)})` : ''}`);
  console.log(`  output  : ${b ? `${fmt(b.out)} → ` : ''}${fmt(a.out)}`);
  console.log(`  turns   : ${d(a.turns, b?.turns)}`);
  console.log(`  cost($) : ${d(a.cost, b?.cost, 4)}\n`);
}
for (const [tag, s] of [[labelA, A], ...(B ? [[labelB, B]] : [])]) {
  if (s.rejected.length) console.log(`Run bị loại (${tag}):\n  ${s.rejected.join('\n  ')}`);
}
