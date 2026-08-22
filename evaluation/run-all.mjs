#!/usr/bin/env node
// run-all.mjs — chạy tuần tự toàn bộ case trong evaluation/cases/ (release gate, `npm test`).
// Mỗi case là một process run-case.mjs với workspace riêng (tự dọn). Tuần tự có chủ đích:
// nhiều case mở Chrome/mock server, chạy song song sẽ giẫm port/tài nguyên.
// Release gate mặc định STRICT: exit 1 khi có FAIL hoặc BLOCKED. Dùng --allow-blocked chỉ cho
// exploratory local runs; CI/npm test không dùng flag này. Một release không được gọi là xanh
// khi prerequisite/network khiến case chưa thực sự chạy.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteExitCode } from './lib/suite-policy.mjs';

const CASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases');
const allowBlocked = process.argv.includes('--allow-blocked');
const ids = fs.readdirSync(CASES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(CASES_DIR, e.name, 'case.json')))
  .map((e) => e.name)
  .sort();

const results = [];
for (const id of ids) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(CASES_DIR, 'run-case.mjs'), id], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const status = res.status === 0 ? 'pass' : res.status === 2 ? 'blocked' : 'fail';
  results.push({ id, status });
  console.log(`${status.toUpperCase().padEnd(7)} ${id} (${secs}s)`);
  if (status !== 'pass') console.log((res.stdout || res.stderr || '').split('\n').slice(-40).join('\n'));
}

const fail = results.filter((r) => r.status === 'fail');
const blocked = results.filter((r) => r.status === 'blocked');
console.log(`\n${results.length} cases: ${results.length - fail.length - blocked.length} pass, ${blocked.length} blocked, ${fail.length} fail`);
if (blocked.length) console.log(`blocked: ${blocked.map((r) => r.id).join(', ')}`);
if (fail.length) console.log(`fail: ${fail.map((r) => r.id).join(', ')}`);
process.exit(suiteExitCode(results, { allowBlocked }));
