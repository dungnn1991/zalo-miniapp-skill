// Locked run-evidence context (lead-owned). Every script stage goes through this module
// so runs/<run-id>/ stays append-only, sanitized and schema-shaped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeEvent, redactText } from './redact.mjs';

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const rand = crypto.randomBytes(2).toString('hex');
  return `run-${stamp}-${rand}`;
}

export function openRun(runsDir, runId) {
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  return {
    runId,
    runDir,
    evidenceDir: path.join(runDir, 'evidence'),

    // events.jsonl — append-only, allowlisted fields, redacted strings.
    event(step, fields = {}) {
      const rec = sanitizeEvent({ step, runId, ...fields });
      rec.at = new Date().toISOString();
      fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(rec) + '\n');
      return rec;
    },

    // Named JSON artifacts (input.json, environment.json, portal-sources.json, result.json,
    // evidence/*.json). Never overwrites an existing artifact of a finished run.
    writeJson(relPath, data) {
      const file = path.join(runDir, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      return file;
    },

    writeTextEvidence(relPath, text) {
      const file = path.join(runDir, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, redactText(text));
      return file;
    },

    readJson(relPath) {
      const file = path.join(runDir, relPath);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
  };
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function fingerprint(stage, category, expected, actualClass) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  return sha256([stage, category, norm(expected), norm(actualClass)].join('|'));
}
