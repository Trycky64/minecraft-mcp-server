import { randomUUID } from 'node:crypto';

const MAX_LOG_TEXT = 2_000;
const sensitiveKey = /^(?:authorization|cookie|set-cookie|secret|token|password|credential|session(?:[_ -]?id)?|bridgeSessionId|mineflayerSessionId)$/i;
const SAFE_DIAGNOSTIC_CODES = new Set([
  'bridge-disabled', 'bridge-unavailable', 'authentication-refused', 'server-identity-mismatch', 'session-expired',
  'stale-registry-epoch', 'capability-unsupported', 'bridge-timeout', 'bridge-http-timeout', 'bridge-rate-limited',
  'invalid-bridge-response', 'bridge-configuration-invalid', 'invalid-request', 'resource-not-found', 'chunk-not-loaded',
  'operation-superseded', 'bridge-request-failed', 'invalid-input', 'minecraft-session-unavailable', 'resource-unavailable',
  'operation-timeout', 'operation-failed', 'internal-error',
]);

/** Scrub secrets and control characters before any untrusted text reaches stderr. */
export function sanitizeLogText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|set-cookie|secret|token|password|credential|session(?:[_ -]?id)?|bridgeSessionId|mineflayerSessionId)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@')
    // eslint-disable-next-line no-control-regex -- this range deliberately strips control characters.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, MAX_LOG_TEXT);
}

/** Same redaction for MCP errors; preserves ordinary existing message text. */
export function sanitizePublicErrorText(value: string): string {
  return sanitizeLogText(value).replace(/\s+/g, ' ').trim() || 'operation-failed';
}

/** Backwards-compatible local log line; message is always single-line and redacted. */
export function log(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  process.stderr.write(`${timestamp} [minecraft] [mcp-server] [${sanitizeLogText(level)}] ${sanitizeLogText(message)}\n`);
}

export interface DiagnosticLogFields {
  code?: string;
  durationMs?: number;
  outcome?: 'success' | 'failure' | 'timeout' | 'invalidated';
  connectionMode?: 'bot' | 'bridge-only' | 'auto';
  adapter?: 'generic-neoforge' | 'processia';
  correlationId?: string;
  sessionGeneration?: number;
}

/** Small local JSONL event format; fields are allowlisted and never include payloads. */
export function logEvent(level: 'debug' | 'info' | 'warn' | 'error', component: string, operation: string, fields: DiagnosticLogFields = {}): void {
  const event: Record<string, string | number> = {
    timestamp: new Date().toISOString(), severity: level,
    component: /^[a-z0-9_.-]{1,64}$/i.test(component) ? component : 'unknown',
    operation: /^[a-z0-9_.-]{1,64}$/i.test(operation) ? operation : 'unknown',
    correlationId: fields.correlationId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fields.correlationId) ? fields.correlationId : randomUUID(),
  };
  if (fields.code) event.code = SAFE_DIAGNOSTIC_CODES.has(fields.code) ? fields.code : 'internal-error';
  if (fields.durationMs !== undefined && Number.isFinite(fields.durationMs) && fields.durationMs >= 0) event.durationMs = fields.durationMs;
  if (fields.outcome) event.outcome = fields.outcome;
  if (fields.connectionMode) event.connectionMode = fields.connectionMode;
  if (fields.adapter) event.adapter = fields.adapter;
  if (fields.sessionGeneration !== undefined && Number.isSafeInteger(fields.sessionGeneration) && fields.sessionGeneration >= 0) {
    event.sessionGeneration = fields.sessionGeneration;
  }
  // Defense in depth if this allowlist is extended later.
  for (const key of Object.keys(event)) if (sensitiveKey.test(key)) delete event[key];
  process.stderr.write(`${JSON.stringify(event)}\n`);
}
