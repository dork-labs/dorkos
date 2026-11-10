/**
 * The sweep a turn-context body goes through before it is stored (Security,
 * Nov 8): nothing a runtime is handed should hold a secret, and if one ever
 * does, the record must not keep it.
 *
 * Two layers. Live secret VALUES this server knows (the local MCP token, keys
 * in its environment) are replaced wherever they appear, whatever their shape.
 * Then the audit log's pattern sweep catches credential SHAPES it does not
 * know the value of. A body that changed says so (`redacted`), so a record is
 * never mistaken for the exact bytes sent.
 *
 * @module services/session/turn-context/turn-context-redaction
 */
import { sweepSecretText } from '../../audit/audit-redaction.js';

/** What a swept-out secret is replaced with. */
const REDACTED = '[redacted]';

/** The local MCP token's shape: a fixed prefix and 64 hex characters. */
const MCP_LOCAL_TOKEN = /dork_mcp_local_[0-9a-f]{16,}/g;

/**
 * A PEM private key: the whole block when it ends, else the header and the
 * base64 lines after it. The body is bounded, so a header with no end costs a
 * bounded scan, never a quadratic one.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:\r?\n[A-Za-z0-9+/=]{16,})*)/g;

/** A value shorter than this is too likely to be an ordinary word to replace everywhere. */
const MIN_KNOWN_SECRET = 12;

/** An environment variable named like it holds a secret. */
const SECRET_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$|^AUTH_/i;

/** A swept body, and whether the sweep changed it. */
export interface SweptBody {
  /** The text as it will be stored. */
  text: string;
  /** True when anything was replaced, so `text` differs from what was sent. */
  redacted: boolean;
}

/**
 * The secret values in an environment: every variable named like a key,
 * token, secret or password whose value is long enough to be one.
 *
 * @param env - The environment to read (defaults to this process's).
 */
export function secretValuesFromEnv(
  // eslint-disable-next-line no-restricted-syntax -- sweeps every secret-named var, which env.ts cannot enumerate
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_KNOWN_SECRET && SECRET_ENV_NAME.test(name)) values.push(trimmed);
  }
  return values;
}

/**
 * Sweep a body before it is stored.
 *
 * @param text - The body exactly as the runtime received it.
 * @param knownSecrets - Live secret values to replace wherever they appear.
 */
export function sweepContextBody(text: string, knownSecrets: readonly string[]): SweptBody {
  let swept = text;
  // Longest first, so a secret that contains another is replaced whole.
  const values = [...new Set(knownSecrets)]
    .filter((value) => value.length >= MIN_KNOWN_SECRET)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    if (swept.includes(value)) swept = swept.split(value).join(REDACTED);
  }
  swept = sweepSecretText(
    swept.replace(PEM_PRIVATE_KEY, REDACTED).replace(MCP_LOCAL_TOKEN, REDACTED)
  );
  return { text: swept, redacted: swept !== text };
}
