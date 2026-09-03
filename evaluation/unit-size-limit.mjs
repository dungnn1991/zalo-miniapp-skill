#!/usr/bin/env node
// unit-size-limit.mjs — boundary test cho scanSizeLimit (slice C2, review file 55/56):
// limit / limit+1 byte cho tổng và từng file; case tổng > limit dù từng file ≤ perFile.
// Chạy trong npm test (trước run-all). Exit 1 nếu lệch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSizeLimit, SIZE_TOTAL_LIMIT, SIZE_FILE_LIMIT } from '../skill/create-zmp-app/scripts/insight.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-limit-'));
  files.forEach((bytes, i) => fs.writeFileSync(path.join(dir, `f${i}.bin`), Buffer.alloc(bytes)));
  return dir;
};
const checks = [];
const expect = (name, dir, status, detailIncludes = null) => {
  const r = scanSizeLimit(dir);
  const ok = r.status === status && (detailIncludes === null || String(r.detail).includes(detailIncludes));
  checks.push({ name, ok, got: `${r.status}: ${r.detail}` });
  fs.rmSync(dir, { recursive: true, force: true });
};
const F = SIZE_FILE_LIMIT, T = SIZE_TOTAL_LIMIT;
expect('one file exactly perFile limit passes', mk([F]), 'pass');
expect('one file perFile+1 fails on per-file', mk([F + 1]), 'fail', 'files over');
expect('total exactly total limit (files <= perFile) passes', mk([F, F, F, T - 3 * F]), 'pass');
expect('total limit+1 (files <= perFile) fails on total', mk([F, F, F, T - 3 * F + 1]), 'fail', 'total');
expect('total over limit while every file <= perFile fails on total', mk([F, F, F, F]), 'fail', 'total');
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` — got ${c.got}`}`);
console.log(`${checks.length} size-limit boundary checks: ${checks.length - failed.length} pass, ${failed.length} fail (limits ${T}/${F} bytes từ config.json platformLimits)`);
process.exit(failed.length ? 1 : 0);
