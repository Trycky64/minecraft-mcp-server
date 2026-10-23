import type {
  BridgeCapabilities, BridgeHandshakeResponse, BridgeMachineInspection, BridgeMachineInspectionRequest,
  BridgeMachineSearchPage, BridgeMachineSearchRequest, BridgeRecipePage, BridgeRegistryPage,
} from './bridge-types.js';
import type { RegistryKind } from '../services/minecraft-registry-service.js';

export type BridgeAdapterKind = 'generic-neoforge' | 'processia';
export type BridgeAdapterState = 'disabled' | 'unconfigured' | 'disconnected' | 'connecting' | 'authenticated' | 'closing' | 'closed';
export type BridgeCapability = 'registry.read' | 'registry.dynamic-index' | 'block.inspect' | 'machine.inspect' |
  'machine.search' | 'recipes.inspect' | 'capability.item-handler' | 'capability.energy-storage' |
  'capability.fluid-handler' | 'capability.processia-gas' | 'capability.processia-heat';

export type BridgeErrorCode = 'bridge-disabled' | 'bridge-unavailable' | 'authentication-refused' |
  'server-identity-mismatch' | 'session-expired' | 'stale-registry-epoch' | 'capability-unsupported' |
  'bridge-timeout' | 'bridge-http-timeout' | 'bridge-rate-limited' | 'invalid-bridge-response' |
  'bridge-configuration-invalid' | 'invalid-request' | 'resource-not-found' | 'chunk-not-loaded' |
  'operation-superseded' | 'bridge-request-failed';

export interface BridgeErrorPolicy { category: string; retryable: boolean; temporary: boolean | null; invalidatesSession: boolean; }

/** One policy table drives MCP diagnostics and session invalidation. */
export function bridgeErrorPolicy(code: BridgeErrorCode): BridgeErrorPolicy {
  const policies: Record<BridgeErrorCode, BridgeErrorPolicy> = {
    'bridge-disabled': { category: 'configuration', retryable: false, temporary: false, invalidatesSession: false },
    'bridge-configuration-invalid': { category: 'configuration', retryable: false, temporary: false, invalidatesSession: false },
    'invalid-request': { category: 'input-validation', retryable: false, temporary: false, invalidatesSession: false },
    'resource-not-found': { category: 'resource-unavailable', retryable: false, temporary: false, invalidatesSession: false },
    'chunk-not-loaded': { category: 'resource-unavailable', retryable: false, temporary: true, invalidatesSession: false },
    'capability-unsupported': { category: 'capability-unsupported', retryable: false, temporary: false, invalidatesSession: false },
    'bridge-http-timeout': { category: 'timeout', retryable: true, temporary: true, invalidatesSession: false },
    'bridge-rate-limited': { category: 'rate-limit', retryable: true, temporary: true, invalidatesSession: false },
    'bridge-timeout': { category: 'timeout', retryable: false, temporary: true, invalidatesSession: true },
    'bridge-unavailable': { category: 'bridge-transport', retryable: true, temporary: true, invalidatesSession: true },
    'authentication-refused': { category: 'authentication', retryable: false, temporary: false, invalidatesSession: true },
    'session-expired': { category: 'session-context', retryable: false, temporary: true, invalidatesSession: true },
    'server-identity-mismatch': { category: 'identity', retryable: false, temporary: false, invalidatesSession: true },
    'stale-registry-epoch': { category: 'session-context', retryable: false, temporary: true, invalidatesSession: true },
    'invalid-bridge-response': { category: 'invalid-response', retryable: false, temporary: false, invalidatesSession: true },
    'operation-superseded': { category: 'operation-invalidated', retryable: false, temporary: true, invalidatesSession: false },
    'bridge-request-failed': { category: 'bridge-transport', retryable: false, temporary: null, invalidatesSession: true },
  };
  return policies[code];
}

/** Session policy is code-driven. Untrusted/malformed invalidation hints never weaken it. */
export function bridgeErrorInvalidatesSession(code: BridgeErrorCode): boolean {
  return bridgeErrorPolicy(code).invalidatesSession;
}

const SAFE_HTTP_PROTOCOL_DIAGNOSTICS = new Set([
  'bridge-unauthorized', 'bridge-forbidden', 'bridge-chunk_not_loaded', 'bridge-session_expired',
]);
const SAFE_DIAGNOSTICS = new Set([
  ...SAFE_HTTP_PROTOCOL_DIAGNOSTICS,
  'bridge-http-status-code-mismatch',
  'bridge-session-metadata-changed', 'bridge-handshake-completed-for-stale-bot-session',
  'bridge-operation-invalidated-by-runtime-session-change', 'bridge-registry-refresh-superseded',
  'bridge-block-response-location-mismatch', 'bridge-machine-response-location-mismatch',
  'bridge-block-response-generation-mismatch', 'bridge-machine-response-generation-mismatch',
  'bridge-machine-search-generation-mismatch', 'bridge-recipe-response-generation-mismatch',
  'bridge-complete-registry-page-set-incomplete', 'bridge-registry-index-contains-duplicates',
  'bridge-registry-index-empty', 'bridge-registry-kind-mismatch', 'bridge-registry-offset-overflow',
  'bridge-registry-page-shape-mismatch', 'bridge-registry-pagination-inconsistent',
  'bridge-registry-snapshot-exceeds-safety-limit', 'bridge-registry-total-exceeds-safety-limit',
  'bridge-capability-security-contract-mismatch', 'bridge-invalid-json', 'bridge-invalid-machine-search-request',
  'bridge-invalid-pagination-request', 'bridge-machine-search-page-shape-mismatch', 'bridge-minecraft-endpoint-mismatch',
  'bridge-minecraft-version-mismatch', 'bridge-minecraft-version-required', 'bridge-neoforge-version-mismatch',
  'bridge-only-requires-generic-neoforge-bridge', 'bridge-only-session-unavailable',
  'bridge-only-session-unavailable-or-stale', 'bridge-recipe-page-shape-mismatch', 'bridge-registry-duplicate-entry',
  'bridge-registry-duplicate-key', 'bridge-registry-index-kind-invalid', 'bridge-registry-numeric-id-collision',
  'bridge-request-timeout', 'bridge-response-too-large', 'bridge-server-identity-mismatch', 'bridge-session-expired',
  'bridge-permission_denied',
  'credential-file-invalid', 'credential-file-permissions-invalid', 'credential-file-too-large',
  'dynamic-registry-index-requires-generic-bridge', 'generic-capabilities-require-generic-bridge',
  'minecraft-endpoint-does-not-match-bridge-configuration', 'processia-machine-search-requires-processia-adapter',
  'processia-recipes-require-processia-adapter', 'active-minecraft-session-required',
  'bridge-adapter-kind-changed-on-reconnect', 'bridge-disabled', 'bridge-handshake-required',
]);

/** Bridge-side identity. `sourceRegistryEpoch` is never the MCP runtime epoch. */
export interface BridgeAdapterSessionContext {
  sessionId: string;
  serverIdentity: string;
  minecraftEndpoint: string;
  minecraftVersion: string;
  neoForgeVersion: string;
  sourceRegistryEpoch: string;
}

export class BridgeAdapterError extends Error {
  readonly invalidatesSession: boolean;

  constructor(readonly code: BridgeErrorCode, diagnostic?: string, invalidatesSession?: unknown) {
    // Keep a sanitized protocol diagnostic in message for existing callers while
    // exposing a stable, protocol-neutral category in `code`.
    super(diagnostic ?? code);
    this.name = 'BridgeAdapterError';
    // Keep the parameter for source compatibility, but never let a caller-provided
    // hint override the policy for authentication, identity, protocol or transport errors.
    void invalidatesSession;
    this.invalidatesSession = bridgeErrorInvalidatesSession(code);
  }
}

export function normalizeBridgeError(error: unknown, sensitiveValues: readonly (string | null | undefined)[] = []): BridgeAdapterError {
  if (error instanceof BridgeAdapterError) {
    const safeMessage = extractSafeDiagnostic(redactSensitiveText(error.message, sensitiveValues).toLowerCase());
    return new BridgeAdapterError(error.code, safeMessage ?? error.code);
  }
  const rawDiagnostic = error instanceof Error ? error.message : '';
  const redactedMessage = redactSensitiveText(rawDiagnostic, sensitiveValues).toLowerCase();
  const message = redactedMessage;
  const errorName = error instanceof Error ? error.name : '';
  let httpStatus: unknown;
  try {
    if (typeof error === 'object' && error !== null && 'status' in error) httpStatus = (error as { status?: unknown }).status;
  } catch { /* Ignore inaccessible metadata and use the conservative message classification. */ }
  let declaredCode: unknown;
  try {
    if (typeof error === 'object' && error !== null && 'bridgeErrorCode' in error) {
      declaredCode = (error as { bridgeErrorCode?: unknown }).bridgeErrorCode;
    }
  } catch { /* Ignore inaccessible metadata and use the conservative message classification. */ }
  const knownCodes: readonly BridgeErrorCode[] = ['bridge-disabled', 'bridge-unavailable', 'authentication-refused',
    'server-identity-mismatch', 'session-expired', 'stale-registry-epoch', 'capability-unsupported', 'bridge-timeout',
    'bridge-http-timeout', 'bridge-rate-limited', 'invalid-bridge-response', 'bridge-configuration-invalid', 'invalid-request',
    'resource-not-found', 'chunk-not-loaded', 'operation-superseded', 'bridge-request-failed'];
  const statusCode: BridgeErrorCode | null = httpStatus === 401 || httpStatus === 403 ? 'authentication-refused'
    : httpStatus === 409 || httpStatus === 410 ? 'session-expired'
    : httpStatus === 408 ? 'bridge-http-timeout'
    : httpStatus === 429 ? 'bridge-rate-limited'
    : httpStatus === 400 || httpStatus === 422 ? 'invalid-request'
    : httpStatus === 404 ? 'resource-not-found'
    : httpStatus === 405 || httpStatus === 501 ? 'capability-unsupported'
    : typeof httpStatus === 'number' && httpStatus >= 500 ? 'bridge-unavailable'
    : null;
  const trustedDeclaredCode = typeof declaredCode === 'string' && knownCodes.includes(declaredCode as BridgeErrorCode)
    ? declaredCode as BridgeErrorCode : null;
  // If untrusted structured metadata claims a revoking error while the HTTP status
  // would normally be non-revoking (for example 408 + authentication-refused),
  // treat the contradiction as an invalid response. Never let it downgrade the
  // session policy; revoking here is deliberately fail-closed.
  const contradictoryRevocation = statusCode !== null && trustedDeclaredCode !== null &&
    bridgeErrorPolicy(trustedDeclaredCode).invalidatesSession && !bridgeErrorPolicy(statusCode).invalidatesSession;
  const code: BridgeErrorCode = contradictoryRevocation ? 'invalid-bridge-response'
    : statusCode ?? trustedDeclaredCode ?? (/bridge-disabled/.test(message) ? 'bridge-disabled'
    : /timeout|timed out/.test(message) ? 'bridge-timeout'
    : /auth|secret|unauthorized|forbidden|http_401|http_403/.test(message) ? 'authentication-refused'
    : /identity|endpoint-mismatch|version-mismatch/.test(message) ? 'server-identity-mismatch'
    : /expired|handshake-required|session-unavailable|session-invalid/.test(message) ? 'session-expired'
    : /epoch|stale|generation|runtime-session-change/.test(message) ? 'stale-registry-epoch'
    : /requires-.*adapter|unsupported|not-supported/.test(message) ? 'capability-unsupported'
    : /^bridge-invalid-(?:pagination|machine-search)-request$/.test(message) ? 'invalid-request'
    : /chunk[_-]not[_-]loaded/.test(message) ? 'chunk-not-loaded'
    : /(?:block|machine|resource)[_-]not[_-]found/.test(message) ? 'resource-not-found'
    : /(?:refresh|operation)[_-](?:superseded|invalidated)/.test(message) ? 'operation-superseded'
    : errorName === 'ZodError' || /schema|malformed|invalid-json|response-.*mismatch|shape-mismatch|metadata-changed|bridge-registry-|response-too-large|capability-security-contract-mismatch|location-mismatch/.test(message) ? 'invalid-bridge-response'
    : /configuration|not-configured|credential-file/.test(message) ? 'bridge-configuration-invalid'
    : /unreachable|http_[45]\d\d|connection refused|fetch failed/.test(message) ? 'bridge-unavailable'
    : 'bridge-request-failed');
  // HTTP response bodies are untrusted even when their error field matches a
  // conservative character schema. Preserve only previously established protocol codes.
  const diagnostic = contradictoryRevocation ? 'bridge-http-status-code-mismatch'
    : typeof httpStatus === 'number'
    ? (SAFE_HTTP_PROTOCOL_DIAGNOSTICS.has(message) ? message : null)
    : extractSafeDiagnostic(redactedMessage);
  return new BridgeAdapterError(code, diagnostic ?? code);
}

function extractSafeDiagnostic(value: string): string | null {
  if (SAFE_DIAGNOSTICS.has(value)) return value;
  const [identifier, ...rest] = value.trim().split(/\s+/);
  if (SAFE_DIAGNOSTICS.has(identifier ?? '') && rest.length > 0 && rest.every((part) => part === '[redacted]')) return identifier!;
  return null;
}

function redactSensitiveText(value: string, sensitiveValues: readonly (string | null | undefined)[]): string {
  let sanitized = value;
  for (const secret of sensitiveValues) {
    if (secret) sanitized = sanitized.split(secret).join('[redacted]');
  }
  sanitized = sanitized
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/((?:secret|token|password|credential)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
  return sanitized;
}

/** Protocol-neutral lifecycle and read-only operations implemented by each bridge adapter. */
export interface BridgeAdapter {
  readonly kind: BridgeAdapterKind;
  readonly state: BridgeAdapterState;
  readonly session: BridgeHandshakeResponse | null;
  readonly sessionContext: BridgeAdapterSessionContext | null;
  readonly capabilities: readonly BridgeCapability[];
  supports(capability: BridgeCapability): boolean;
  handshake(minecraftVersion: string, expectedEndpoint: string): Promise<BridgeHandshakeResponse>;
  closeSession(): Promise<void>;
  clearSession(): void;
  close(): Promise<void>;
  getServerCapabilities(): Promise<BridgeCapabilities>;
  getRegistryKinds(): Promise<string[]>;
  getRegistryPage(kind: RegistryKind, offset: number, limit: number): Promise<BridgeRegistryPage>;
  inspectBlock(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection>;
  inspectMachine(request: BridgeMachineInspectionRequest): Promise<BridgeMachineInspection>;
  listMachines(request: BridgeMachineSearchRequest): Promise<BridgeMachineSearchPage>;
  inspectRecipes(offset?: number, limit?: number, kind?: string): Promise<BridgeRecipePage>;
}
