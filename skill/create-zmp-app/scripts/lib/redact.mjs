// Locked redaction + allowlist logging rules (lead-owned).
// Policy (plan §10): allowlist fields at the logger, and additionally scrub any
// secret-shaped value from free-text before it reaches an artifact. APP_ID is not a secret.
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,                 // GitHub tokens
  /sk-[A-Za-z0-9_-]{16,}/g,                      // API secret keys
  /AIza[0-9A-Za-z_-]{20,}/g,                     // Google API keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,               // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /(ZMP_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|APP_SECRET|API_KEY|X-API-KEY|AUTHORIZATION)\s*[=:]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /(set-cookie|cookie)\s*:\s*[^\n]+/gi,
];

export function redactText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

// Allowlisted event fields — anything else passed to the event logger is dropped, not blacklisted.
export const EVENT_FIELD_ALLOWLIST = new Set([
  'step', 'stage', 'status', 'startedAt', 'finishedAt', 'durationMs',
  'exitCode', 'message', 'detail', 'gateId', 'viewport', 'url', 'path',
  'findingId', 'runId', 'command',
]);

export function sanitizeEvent(event) {
  const out = {};
  for (const [k, v] of Object.entries(event)) {
    if (!EVENT_FIELD_ALLOWLIST.has(k)) continue;
    out[k] = typeof v === 'string' ? redactText(v) : v;
  }
  return out;
}
