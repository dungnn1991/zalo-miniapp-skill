#!/usr/bin/env node
// portal-fetch.mjs — stage 2 of the create-zmp-app pipeline (Subagent A).
// Live Portal grounding per plan §7: fetch MA/llms.txt, route a SMALL set of doc slugs by
// topic, fetch each /docs/MA/....md, record {url, fetchedAt, etag, sha256, status} in
// runs/<id>/portal-sources.json and save bodies under runs/<id>/portal/ as evidence trace.
// NO bundled corpus, NO silent fallback: index unavailable -> exit 1 + finding portal_unavailable.
//
// CLI: node portal-fetch.mjs --run-id <id> [--topics <csv>] [--workspace <dir>]
// Env (test-only, see references/portal-routing.md): MB_PORTAL_BASE_URL overrides portal.baseUrl.
//
// Exit codes: 0 index + >=1 doc fetched · 1 portal/gate failure (finding recorded) ·
// 3 precondition/config error.

import fs from 'node:fs';
import path from 'node:path';
import { loadLabConfig, resolveWorkspace, getArg } from './lib/paths.mjs';
import { openRun, sha256, fingerprint } from './lib/run-context.mjs';
import { redactText } from './lib/redact.mjs';

const FETCH_TIMEOUT_MS = 20000;
const MAX_DOCS = 8;
const DEFAULT_TOPICS = ['getting-started', 'app-config', 'zaui', 'devtools'];
// Components the template imports from zmp-ui (references/app-contract.md), in priority order.
const ZAUI_COMPONENTS = ['App', 'Page', 'Button', 'BottomNavigation', 'Icon'];

function die(message, code = 3) {
  process.stderr.write(`portal-fetch: ${message}\n`);
  process.exit(code);
}

// Same dynamic-import contract + fallback as bootstrap.mjs (Subagent C owns record-finding.mjs).
async function recordFindingSafe(args) {
  try {
    const mod = await import('./record-finding.mjs');
    if (typeof mod.recordFinding === 'function') return await mod.recordFinding(args);
  } catch {
    // fall through to the fallback writer
  }
  const now = new Date().toISOString();
  const fp = fingerprint(args.stage, args.category, args.expected, args.actualClass || args.actual);
  const record = {
    schemaVersion: '1.0',
    findingId: `finding_${fp.slice(0, 12)}`,
    fingerprint: fp,
    runId: args.runId,
    stage: args.stage,
    category: args.category,
    severity: args.severity,
    expected: redactText(args.expected),
    actual: redactText(args.actual),
    evidence: args.evidence || [],
    status: 'open',
    firstSeenAt: now,
    lastSeenAt: now,
    occurrences: 1,
  };
  const file = path.join(args.workspace.feedbackDir, 'findings.jsonl');
  fs.mkdirSync(args.workspace.feedbackDir, { recursive: true });
  const existing = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const idx = existing.findIndex((f) => f.fingerprint === fp);
  if (idx >= 0) {
    existing[idx].lastSeenAt = now;
    existing[idx].occurrences = (existing[idx].occurrences || 1) + 1;
    fs.writeFileSync(file, existing.map((f) => JSON.stringify(f)).join('\n') + '\n');
    return existing[idx];
  }
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

// Parse Markdown links [title](absolute .md url) out of the llms.txt index.
function parseIndexLinks(indexText, baseUrl, docPathPrefix) {
  const links = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^\s)]+\.md)\)/g;
  let m;
  while ((m = re.exec(indexText)) !== null) {
    const url = m[2];
    if (url.startsWith(baseUrl + docPathPrefix)) {
      links.push({ title: m[1], url, slugPath: url.slice((baseUrl + docPathPrefix).length) });
    }
  }
  return links;
}

// Topic -> slug selection rules (documented in references/portal-routing.md).
// Every requested topic contributes its head doc first, then remaining docs top up in
// topic order; dedupe by URL, cap at MAX_DOCS trimming from the tail.
function selectDocs(links, topics) {
  const groups = [];
  let picked;
  const pick = (predicate, limit = 1) => {
    let n = 0;
    for (const l of links) {
      if (n >= limit) break;
      if (predicate(l)) {
        picked.push(l);
        n += 1;
      }
    }
  };

  for (const topic of topics) {
    picked = [];
    groups.push(picked);
    switch (topic) {
      case 'getting-started':
        pick((l) => l.slugPath === 'intro/getting-started.md');
        break;
      case 'app-config':
        pick((l) => l.slugPath.endsWith('/app-config.md') || l.slugPath === 'app-config.md');
        break;
      case 'zaui':
        pick((l) => /^zaui\/overview\/installation\.md$/i.test(l.slugPath));
        for (const comp of ZAUI_COMPONENTS) {
          pick((l) => new RegExp(`^zaui/[a-z-]+/${comp}\\.md$`).test(l.slugPath));
        }
        break;
      case 'devtools':
        // Local build/render guidance only — never login/deploy docs (guardrail).
        pick((l) => l.slugPath === 'devtools/cli/intro.md' || /devtools\/cli\/start\.md$/.test(l.slugPath));
        break;
      default:
        // Generic fallback for explicit --topics values: substring on slug or title.
        pick(
          (l) =>
            l.slugPath.toLowerCase().includes(topic.toLowerCase()) ||
            l.title.toLowerCase().includes(topic.toLowerCase()),
          2
        );
    }
  }

  // Heads first (one per topic, in topic order), then the rest in topic order.
  const ordered = [];
  for (const g of groups) if (g.length > 0) ordered.push(g[0]);
  for (const g of groups) ordered.push(...g.slice(1));

  const seen = new Set();
  const out = [];
  for (const l of ordered) {
    if (seen.has(l.url)) continue;
    seen.add(l.url);
    out.push(l);
    if (out.length >= MAX_DOCS) break;
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/plain, text/markdown, */*' },
  });
  const body = res.ok ? await res.text() : null;
  return { status: res.status, etag: res.headers.get('etag'), body };
}

async function main() {
  const argv = process.argv.slice(2);
  let config;
  try {
    config = loadLabConfig();
  } catch (e) {
    die(`cannot load lab.config.json: ${e.message}`);
  }
  const workspace = resolveWorkspace(argv);
  const runId = getArg(argv, 'run-id', null);
  if (!runId) die('missing required --run-id');
  const runDir = path.join(workspace.runsDir, runId);
  if (!fs.existsSync(runDir)) die(`run dir not found: ${runDir} (run bootstrap first)`);

  const baseUrl = process.env.MB_PORTAL_BASE_URL || config.portal.baseUrl;
  const indexUrl = baseUrl + config.portal.llmsIndexPath;
  const docPathPrefix = config.portal.docPathPrefix;
  const topics = (getArg(argv, 'topics', null) || DEFAULT_TOPICS.join(','))
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const ctx = openRun(workspace.runsDir, runId);

  // --- Index: the only blocking fetch. No snapshot fallback of any kind. ---
  let indexText;
  try {
    const res = await fetchText(indexUrl);
    if (res.status !== 200 || res.body === null) {
      throw new Error(`HTTP ${res.status}`);
    }
    indexText = res.body;
    ctx.event('portal-fetch', { stage: 'portal', status: 'ok', url: indexUrl, detail: 'index fetched' });
  } catch (e) {
    ctx.event('portal-fetch', {
      stage: 'portal',
      status: 'fail',
      url: indexUrl,
      detail: `index unavailable: ${e.message}`,
    });
    await recordFindingSafe({
      workspace,
      runId,
      runDir: ctx.runDir,
      stage: 'portal',
      category: 'environment',
      severity: 'blocking',
      expected: `live Portal index reachable at ${config.portal.llmsIndexPath} (HTTP 200)`,
      actual: `portal_unavailable: ${indexUrl} -> ${e.message}; no snapshot fallback`,
      actualClass: 'portal_unavailable',
      evidence: ['events.jsonl'],
    });
    process.stdout.write(JSON.stringify({ runId, status: 'fail' }) + '\n');
    process.exit(1);
  }

  const links = parseIndexLinks(indexText, baseUrl, docPathPrefix);
  const selected = selectDocs(links, topics);
  ctx.event('portal-fetch', {
    stage: 'portal',
    status: 'ok',
    detail: `index links=${links.length}, selected=${selected.length} (topics: ${topics.join(', ')})`,
  });

  // --- Per-doc fetches: individual failures are recorded but do not stop the rest. ---
  const sources = [];
  let fetchedCount = 0;
  for (const doc of selected) {
    const fetchedAt = new Date().toISOString();
    try {
      const res = await fetchText(doc.url);
      if (res.status === 200 && res.body !== null) {
        const fileName = doc.slugPath.replaceAll('/', '__'); // collision-safe basename
        ctx.writeTextEvidence(path.join('portal', fileName), res.body);
        sources.push({ url: doc.url, fetchedAt, etag: res.etag, sha256: sha256(res.body), status: 'fetched' });
        fetchedCount += 1;
        ctx.event('portal-fetch', { stage: 'portal', status: 'ok', url: doc.url, path: `portal/${fileName}` });
      } else {
        sources.push({ url: doc.url, fetchedAt, etag: res.etag, sha256: null, status: 'failed' });
        ctx.event('portal-fetch', { stage: 'portal', status: 'fail', url: doc.url, detail: `HTTP ${res.status}` });
        await recordFindingSafe({
          workspace,
          runId,
          runDir: ctx.runDir,
          stage: 'portal',
          category: 'portal-content',
          severity: 'major',
          expected: 'every doc URL listed in MA/llms.txt resolves with HTTP 200',
          actual: `portal_doc_fetch_failed: ${doc.url} -> HTTP ${res.status}`,
          actualClass: 'portal_doc_fetch_failed',
          evidence: ['portal-sources.json'],
        });
      }
    } catch (e) {
      sources.push({ url: doc.url, fetchedAt, etag: null, sha256: null, status: 'failed' });
      ctx.event('portal-fetch', { stage: 'portal', status: 'fail', url: doc.url, detail: e.message });
      await recordFindingSafe({
        workspace,
        runId,
        runDir: ctx.runDir,
        stage: 'portal',
        category: 'environment',
        severity: 'major',
        expected: 'network path to Portal doc URLs is available during the run',
        actual: `portal_doc_fetch_failed: ${doc.url} -> ${e.message}`,
        actualClass: 'portal_doc_fetch_failed',
        evidence: ['portal-sources.json'],
      });
    }
  }

  ctx.writeJson('portal-sources.json', { schemaVersion: '1.0', baseUrl, sources });
  ctx.event('portal-fetch', {
    stage: 'portal',
    status: fetchedCount > 0 ? 'ok' : 'fail',
    detail: `fetched ${fetchedCount}/${selected.length} docs`,
  });

  if (fetchedCount > 0) {
    process.stdout.write(JSON.stringify({ runId, status: 'ok' }) + '\n');
    process.exit(0);
  }
  await recordFindingSafe({
    workspace,
    runId,
    runDir: ctx.runDir,
    stage: 'portal',
    category: 'portal-content',
    severity: 'blocking',
    expected: 'at least one routed Portal doc fetched for grounding',
    actual: `portal_no_docs_fetched: 0/${selected.length} selected docs fetched`,
    actualClass: 'portal_no_docs_fetched',
    evidence: ['portal-sources.json'],
  });
  process.stdout.write(JSON.stringify({ runId, status: 'fail' }) + '\n');
  process.exit(1);
}

main().catch((e) => die(e.stack || String(e)));
