#!/usr/bin/env node
// sync-template-catalog.mjs — DRIFT REPORTER for catalog/templates.json (Subagent B, plan 34 §4.1).
//
// This script NEVER writes catalog/templates.json and NEVER promotes a qualification state.
// It reads three upstream sources, compares them against the pinned registry, and prints what
// changed. Promotion is the exclusive job of qualify-template.mjs --promote (plan 34 §4.4,
// CONTRACT-plan34 rule 1: "runtime không fetch catalog mutable; headObserved chỉ để phát hiện drift").
//
// Sources:
//   1. Portal/CLI catalog: https://miniapp.zaloplatforms.com/static/static/templates/index.json
//      Review 35 F8: this is an UNPUBLISHED contract. The single-`static` sibling URL answers
//      HTTP 200 with `content-type: text/html` (SPA fallback), so a naive fetch+JSON.parse of a
//      mistyped URL yields "no templates" and would be reported as "everything was delisted".
//      Every response is therefore validated on content-type + array shape + per-item shape +
//      a sane floor count, and a failure is LOUD (exit 2), never an empty diff.
//   2. GitHub org listing (unauthenticated) for `zaui-*` repo discovery, archived flag, SPDX.
//      Unauthenticated GitHub allows 60 req/h per IP. When that budget is gone the API answers
//      403 — reported as `rate-limited` with the reset time and every GitHub-derived comparison
//      is marked `unknown`, NEVER as "no changes".
//   3. `git ls-remote` per known repo for HEAD SHAs. This is the git protocol, not the REST API,
//      so it keeps working while the API is rate-limited and is the source for headObserved drift.
//
// Usage:
//   node sync-template-catalog.mjs [--registry <path>] [--out <machine-json>] [--format text|json]
//                                  [--no-github] [--no-ls-remote]
// Exit codes: 0 report produced (with or without drift) · 2 source validation failed · 3 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..');
export const DEFAULT_REGISTRY = path.join(SKILL_DIR, 'catalog', 'templates.json');

export const PORTAL_INDEX_URL = 'https://miniapp.zaloplatforms.com/static/static/templates/index.json';
export const GITHUB_ORG = 'Zalo-MiniApp';
export const REPO_PREFIX = 'zaui-';
// Floor, not an expectation: the Portal listed 9 templates on 2026-08-22. Anything below this is
// a broken/placeholder payload, not a real delisting wave — fail loud instead of reporting drift.
export const PORTAL_MIN_COUNT = 5;

// The dev shell exports HTTPS_PROXY=http://10.164.68.254:81, whose TLS interception makes every
// pnpm/git/node TLS handshake fail with `self-signed certificate in certificate chain`. Node's
// own fetch (undici) ignores proxy env vars, but git and pnpm honour them, so every child we
// spawn gets a sanitized copy of the environment. Users behind a corporate proxy hit exactly the
// same wall otherwise, and the failure surfaces as an unrelated "cannot resolve host" error.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[key];
  }
  return env;
}

export function getArg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

// --- sources -------------------------------------------------------------------------------

/**
 * Fetch + validate the Portal catalog. Throws (never returns a partial result) when any check
 * fails, so the caller can exit 2 instead of computing a diff against a wrong payload.
 */
export async function fetchPortalIndex(url = PORTAL_INDEX_URL, { timeoutMs = 30000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  const fail = (why) => {
    const err = new Error(`portal source validation failed: ${why}`);
    err.detail = { url, httpStatus: res.status, contentType, bodyBytes: body.length, bodyHead: body.slice(0, 160) };
    throw err;
  };
  if (!res.ok) fail(`HTTP ${res.status}`);
  // Review 35 F8 — the SPA fallback answers 200 text/html; treating that as "0 templates" would
  // report every registry entry as delisted.
  if (!contentType.includes('application/json')) fail(`content-type is "${contentType}", expected application/json (SPA HTML fallback?)`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    fail(`body is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) fail(`payload root is ${parsed === null ? 'null' : typeof parsed}, expected an array`);
  if (parsed.length < PORTAL_MIN_COUNT) fail(`only ${parsed.length} entries, below the sane floor of ${PORTAL_MIN_COUNT}`);
  const malformed = parsed.filter((e) => !e || typeof e.id !== 'string' || !e.github || typeof e.github.repository !== 'string');
  if (malformed.length) fail(`${malformed.length}/${parsed.length} entries lack id/github.repository — shape changed`);
  return { url, httpStatus: res.status, contentType, count: parsed.length, entries: parsed };
}

/** GitHub org repo listing. Never throws — a failure becomes a status the report can print. */
export async function fetchOrgRepos(org = GITHUB_ORG, { timeoutMs = 30000, token = process.env.GITHUB_TOKEN || null } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'create-zmp-app-sync-template-catalog' };
  if (token) headers.authorization = `Bearer ${token}`;
  const repos = [];
  let url = `https://api.github.com/orgs/${org}/repos?per_page=100&type=public`;
  while (url) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
    } catch (err) {
      return { status: 'error', detail: `network error: ${err.message}`, repos: null };
    }
    if (!res.ok) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        return {
          status: 'rate-limited',
          detail: `unauthenticated GitHub API budget exhausted; resets at ${reset ? new Date(reset * 1000).toISOString() : 'unknown'}`
            + ' (set GITHUB_TOKEN to raise the limit)',
          repos: null,
        };
      }
      return { status: 'error', detail: `HTTP ${res.status} ${(await res.text()).slice(0, 160)}`, repos: null };
    }
    repos.push(...(await res.json()));
    const link = res.headers.get('link') || '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  return {
    status: 'ok',
    detail: `${repos.length} public repos, ${repos.filter((r) => r.name.startsWith(REPO_PREFIX)).length} matching ${REPO_PREFIX}*`,
    repos: repos
      .filter((r) => r.name.startsWith(REPO_PREFIX))
      .map((r) => ({
        name: r.name,
        defaultBranch: r.default_branch,
        archived: !!r.archived,
        spdx: r.license?.spdx_id ?? null,
        pushedAt: r.pushed_at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** HEAD SHA of a branch via the git wire protocol (no REST budget). null when unresolvable. */
export function resolveHeadSha(owner, repo, branch) {
  const res = spawnSync('git', ['ls-remote', `https://github.com/${owner}/${repo}`, 'HEAD', `refs/heads/${branch}`], {
    encoding: 'utf8',
    env: childEnv(),
    timeout: 30000,
  });
  if (res.status !== 0) return null;
  const lines = String(res.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const onBranch = lines.find((l) => l[1] === `refs/heads/${branch}`);
  const head = lines.find((l) => l[1] === 'HEAD');
  return (onBranch || head)?.[0] ?? null;
}

// --- comparison ----------------------------------------------------------------------------

// The registry stores some headObserved values abbreviated (8 hex). Comparing a 40-hex upstream
// SHA against an 8-hex record with === would report drift on every single run, so compare with
// prefix semantics on the shorter of the two.
export function shaMatches(a, b) {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function compareCatalog(registry, portal, github, headShas) {
  const drift = [];
  const add = (kind, id, detail, extra = {}) => drift.push({ kind, id, detail, ...extra });

  const byId = new Map(registry.templates.map((t) => [t.id, t]));
  const portalIds = new Set(portal.entries.map((e) => e.id));
  const githubKnown = github.status === 'ok';
  const githubByName = new Map((github.repos || []).map((r) => [r.name, r]));

  // 1. New upstream entries the registry has never seen.
  for (const id of [...portalIds].sort()) {
    if (!byId.has(id)) add('new_repo', id, `listed on Portal but absent from the registry`, { source: 'portal' });
  }
  if (githubKnown) {
    for (const repo of github.repos) {
      if (!byId.has(repo.name)) add('new_repo', repo.name, `${REPO_PREFIX}* repo in the org but absent from the registry`, { source: 'github' });
    }
  }

  for (const t of [...registry.templates].sort((a, b) => a.id.localeCompare(b.id))) {
    const src = t.source;

    // 2. Portal listing drift in both directions.
    if (src.portalListed && !portalIds.has(t.id)) {
      add('portal_delisted', t.id, 'registry says portalListed=true but the Portal catalog no longer lists it');
    }
    if (!src.portalListed && portalIds.has(t.id)) {
      add('portal_listed', t.id, 'registry says portalListed=false but the Portal catalog now lists it');
    }
    const portalEntry = portal.entries.find((e) => e.id === t.id);
    if (portalEntry?.github?.branch && portalEntry.github.branch !== src.defaultBranch) {
      add('branch_drift', t.id, `Portal says branch "${portalEntry.github.branch}", registry says "${src.defaultBranch}"`);
    }

    // 3. HEAD drift — the reason headObserved exists at all.
    const head = headShas.get(t.id);
    if (head === undefined) {
      add('head_unknown', t.id, 'HEAD not resolved (ls-remote disabled or failed) — drift status unknown, NOT "unchanged"');
    } else if (head === null) {
      add('head_unresolvable', t.id, `git ls-remote could not resolve ${src.owner}/${src.repository}#${src.defaultBranch}`);
    } else if (!shaMatches(head, src.headObserved)) {
      add('head_drift', t.id, `upstream HEAD ${head} != recorded headObserved ${src.headObserved ?? 'null'}`, { upstreamHead: head });
    }
    // 4. Pinned-evidence staleness (plan 34 §4.4: a new upstream SHA invalidates old evidence).
    if (head && t.qualification.testedRevision && !shaMatches(head, t.qualification.testedRevision)) {
      add('evidence_stale', t.id,
        `qualification.testedRevision ${t.qualification.testedRevision} is behind upstream HEAD ${head}`
        + ` — evidence for state "${t.qualification.state}" no longer covers HEAD (derived state falls back to candidate)`);
    }
    if (t.qualification.state === 'release-supported' && !shaMatches(src.revision, t.qualification.testedRevision)) {
      add('registry_inconsistent', t.id,
        `state=release-supported but source.revision (${src.revision ?? 'null'}) != qualification.testedRevision (${t.qualification.testedRevision ?? 'null'})`);
    }

    // 5. GitHub metadata: archived + license. Unknown when the API budget is gone.
    if (!githubKnown) continue;
    const repo = githubByName.get(t.id);
    if (!repo) {
      if (portalIds.has(t.id)) add('repo_missing', t.id, `Portal lists it but no ${REPO_PREFIX}* repo of that name is public in the org`);
      continue;
    }
    if (repo.archived) add('archived', t.id, 'upstream repo is archived — candidate for state=deprecated');
    if (repo.defaultBranch !== src.defaultBranch) {
      add('branch_drift', t.id, `GitHub default branch "${repo.defaultBranch}", registry says "${src.defaultBranch}"`);
    }
    const recordedSpdx = src.licenseFile;
    const upstreamSpdx = repo.spdx === 'NOASSERTION' ? 'NOASSERTION' : repo.spdx;
    if ((recordedSpdx ?? null) !== (upstreamSpdx ?? null)) {
      add('license_drift', t.id, `GitHub SPDX "${upstreamSpdx ?? 'null'}" != registry licenseFile "${recordedSpdx ?? 'null'}"`);
    }
  }

  return drift.sort((a, b) => (a.id === b.id ? a.kind.localeCompare(b.kind) : a.id.localeCompare(b.id)));
}

// --- report --------------------------------------------------------------------------------

export function renderReport(report) {
  const L = [];
  L.push(`# catalog drift report — ${report.registryVersion} (observed ${report.observedAt})`);
  L.push('');
  L.push('## sources');
  L.push(`- portal      : ${report.sources.portal.status} — ${report.sources.portal.detail}`);
  L.push(`- github api  : ${report.sources.github.status} — ${report.sources.github.detail}`);
  L.push(`- git ls-remote: ${report.sources.lsRemote.status} — ${report.sources.lsRemote.detail}`);
  L.push('');
  if (report.sources.github.status !== 'ok') {
    L.push('! GitHub-derived checks (new repo discovery, archived flag, SPDX license) are UNKNOWN');
    L.push('  this run. Absence of those drift rows below does NOT mean "no changes".');
    L.push('');
  }
  L.push(`## drift — ${report.drift.length} item(s)`);
  if (!report.drift.length) {
    L.push('  (none of the checked fields moved)');
  } else {
    const width = Math.max(...report.drift.map((d) => d.kind.length));
    for (const d of report.drift) L.push(`  ${d.kind.padEnd(width)}  ${d.id.padEnd(18)} ${d.detail}`);
  }
  L.push('');
  L.push('## registry state (unchanged by this script)');
  for (const [state, ids] of Object.entries(report.stateSummary)) L.push(`  ${state.padEnd(20)} ${ids.join(', ')}`);
  L.push('');
  L.push('This script is a reporter. Promotion runs through: node scripts/qualify-template.mjs --id <id> --promote');
  return L.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const registryPath = path.resolve(getArg(argv, 'registry', DEFAULT_REGISTRY));
  const outPath = getArg(argv, 'out');
  const format = getArg(argv, 'format', 'text');
  if (!['text', 'json'].includes(format)) {
    console.error('sync: --format must be text|json');
    process.exit(3);
  }
  if (!fs.existsSync(registryPath)) {
    console.error(`sync: registry not found: ${registryPath}`);
    process.exit(3);
  }
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  let portal;
  try {
    portal = await fetchPortalIndex();
  } catch (err) {
    // Loud, exit 2. An unreachable/malformed Portal source must never be summarised as a diff.
    console.error(`sync: ${err.message}`);
    if (err.detail) console.error(`sync: ${JSON.stringify(err.detail)}`);
    console.error('sync: refusing to report drift against an unvalidated source (review 35 F8)');
    process.exit(2);
  }

  const github = argv.includes('--no-github')
    ? { status: 'skipped', detail: '--no-github', repos: null }
    : await fetchOrgRepos();

  const headShas = new Map();
  const lsRemote = { status: 'ok', detail: '' };
  if (argv.includes('--no-ls-remote')) {
    lsRemote.status = 'skipped';
    lsRemote.detail = '--no-ls-remote; HEAD drift not checked';
  } else {
    let failures = 0;
    for (const t of registry.templates) {
      const sha = resolveHeadSha(t.source.owner, t.source.repository, t.source.defaultBranch);
      if (sha === null) failures++;
      headShas.set(t.id, sha);
    }
    lsRemote.detail = `${registry.templates.length - failures}/${registry.templates.length} HEAD resolved`;
    if (failures) lsRemote.status = 'partial';
  }

  const drift = compareCatalog(registry, portal, github, headShas);
  const stateSummary = {};
  for (const t of [...registry.templates].sort((a, b) => a.id.localeCompare(b.id))) {
    (stateSummary[t.qualification.state] ??= []).push(t.id);
  }

  const report = {
    schemaVersion: 1,
    tool: 'sync-template-catalog',
    observedAt: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    registryPath,
    registryVersion: registry.registryVersion,
    mutatedRegistry: false,
    sources: {
      portal: { status: 'ok', detail: `${portal.count} entries, ${portal.contentType}`, url: PORTAL_INDEX_URL, count: portal.count, ids: portal.entries.map((e) => e.id).sort() },
      github: { status: github.status, detail: github.detail, repos: github.repos },
      lsRemote: { ...lsRemote, heads: Object.fromEntries([...headShas.entries()].sort()) },
    },
    stateSummary,
    drift,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(format === 'json' ? JSON.stringify(report, null, 2) : renderReport(report));
  process.exit(0);
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) await main();
