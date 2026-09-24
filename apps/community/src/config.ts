import { z } from 'zod';
import {
  COMMUNITY_RESERVED_SHORT_NAMES,
  COMMUNITY_SHORT_NAME_PATTERN,
} from '@dorkos/shared/community-admin-wire';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommunityReportMailto } from '@dorkos/shared/community-wire';

const integer = (name: string, fallback: number, ceiling: number) =>
  z.coerce.number().int().min(1, `${name} must be positive`).max(ceiling).default(fallback);

/** An optional setting that Compose may pass through as an empty string. */
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional()
);

/**
 * Validate one host link: an `https:` page, or for abuse reports also one bare `mailto:` mailbox.
 * Returns `null` when unset, so a self-hosted Community shows no link at all.
 */
function hostLink(name: string, value: string | undefined, allowMailto = false): string | null {
  if (value === undefined) return null;
  const allowed = allowMailto
    ? 'an https:// address or one mailto: address'
    : 'an https:// address';
  if (allowMailto && value.startsWith('mailto:')) {
    const mailbox = parseCommunityReportMailto(value);
    if (mailbox) return mailbox;
    throw new Error(`${name} must be ${allowed}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`${name} must be ${allowed}`, { cause });
  }
  if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href;
  throw new Error(`${name} must be ${allowed}`);
}

/** The directory the server serves its web app from (`main.ts`), from `src/` or `dist-server/`. */
const SERVED_WEB_APP_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url));

/**
 * A path with every symbolic link resolved, for as much of it as exists, so `/tmp/x` and
 * `/private/tmp/x` compare equal on a host where one links to the other.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `child` is `parent` or sits anywhere inside it. */
function within(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Whether two directories are the same, or one contains the other. */
function directoriesOverlap(a: string, b: string): boolean {
  for (const left of new Set([resolve(a), realPath(a)])) {
    for (const right of new Set([resolve(b), realPath(b)])) {
      if (within(left, right) || within(right, left)) return true;
    }
  }
  return false;
}

/** Refuse an S3 endpoint that is not HTTPS (or HTTP on localhost) or that carries credentials. */
function checkS3Endpoint(name: string, value: string | undefined): void {
  if (!value) return;
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))
  ) {
    throw new Error(`${name} must use HTTPS, or HTTP on localhost`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`${name} must not contain credentials`);
  }
}

const schema = z.object({
  COMMUNITY_DATABASE_URL: z.url().startsWith('postgres'),
  COMMUNITY_AUTH_SECRET: z.string().min(32),
  COMMUNITY_INVITE_SECRET: z.string().min(32),
  COMMUNITY_INVITE_KEY_ID: z
    .string()
    .regex(/^[-\w]{1,32}$/)
    .default('v1'),
  COMMUNITY_INVITE_PREVIOUS_KEY_ID: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^[-\w]{1,32}$/)
      .optional()
  ),
  COMMUNITY_INVITE_PREVIOUS_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32).optional()
  ),
  COMMUNITY_BOOTSTRAP_SECRET: z.string().min(32),
  COMMUNITY_PUBLIC_URL: z.url(),
  COMMUNITY_STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  COMMUNITY_STORAGE_PATH: z.string().min(1).optional(),
  COMMUNITY_S3_BUCKET: z.string().min(3).max(63).optional(),
  COMMUNITY_S3_REGION: z.string().min(1).optional(),
  COMMUNITY_S3_ENDPOINT: z.url().optional(),
  COMMUNITY_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  COMMUNITY_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  // The evidence store: a second, independent place takedowns copy removed content to. The
  // server only ever writes there. Unset means no evidence store.
  COMMUNITY_EVIDENCE_DRIVER: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.enum(['filesystem', 's3']).optional()
  ),
  COMMUNITY_EVIDENCE_PATH: optionalText,
  COMMUNITY_EVIDENCE_S3_BUCKET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(3).max(63).optional()
  ),
  COMMUNITY_EVIDENCE_S3_REGION: optionalText,
  COMMUNITY_EVIDENCE_S3_ENDPOINT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.url().optional()
  ),
  COMMUNITY_EVIDENCE_S3_ACCESS_KEY_ID: optionalText,
  COMMUNITY_EVIDENCE_S3_SECRET_ACCESS_KEY: optionalText,
  COMMUNITY_EVIDENCE_S3_PREFIX: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .regex(/^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/)
      .optional()
  ),
  // How long a takedown's evidence may stay unsaved before the worker logs a warning each hour.
  COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS: integer(
    'COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS',
    6,
    168
  ),
  COMMUNITY_PORT: integer('COMMUNITY_PORT', 6481, 65535),
  COMMUNITY_TEST_RUNTIME: z.enum(['true', 'false']).default('false'),
  COMMUNITY_POSTS_PER_TEN_MINUTES: integer('COMMUNITY_POSTS_PER_TEN_MINUTES', 120, 1000),
  COMMUNITY_AGENTS_PER_OWNER: integer('COMMUNITY_AGENTS_PER_OWNER', 20, 100),
  COMMUNITY_TEXT_BYTES: integer('COMMUNITY_TEXT_BYTES', 16 * 1024, 64 * 1024),
  COMMUNITY_ATTACHMENTS_PER_POST: integer('COMMUNITY_ATTACHMENTS_PER_POST', 4, 8),
  COMMUNITY_ATTACHMENT_BYTES: integer(
    'COMMUNITY_ATTACHMENT_BYTES',
    10 * 1024 * 1024,
    25 * 1024 * 1024
  ),
  COMMUNITY_UPLOAD_BYTES_PER_DAY: integer(
    'COMMUNITY_UPLOAD_BYTES_PER_DAY',
    200 * 1024 * 1024,
    1024 * 1024 * 1024
  ),
  COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE: integer('COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE', 10, 100),
  COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE: integer(
    'COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE',
    10,
    100
  ),
  COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE: integer(
    'COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE',
    20,
    100
  ),
  COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE: integer('COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE', 5, 100),
  COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE: integer(
    'COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE',
    20,
    100
  ),
  COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE: integer('COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE', 5, 20),
  // A notice shorter than a week would not give an owner a fair chance to export.
  COMMUNITY_HOST_DELETION_NOTICE_DAYS: z.coerce.number().int().min(7).max(365).default(14),
  COMMUNITY_SHORT_NAME_COOLOFF_DAYS: z.coerce.number().int().min(0).max(365).default(90),
  COMMUNITY_NAME_LOOKUPS_PER_MINUTE: integer('COMMUNITY_NAME_LOOKUPS_PER_MINUTE', 60, 600),
  // The header a trusted reverse proxy sets to the caller's address. Off unless named.
  COMMUNITY_TRUSTED_PROXY_HEADER: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined),
    z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .optional()
  ),
  // Comma-separated short names this host keeps for itself, beside the built-in list.
  COMMUNITY_RESERVED_SHORT_NAMES: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined),
    z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      )
      .pipe(z.array(z.string().regex(COMMUNITY_SHORT_NAME_PATTERN)))
      .optional()
  ),
  COMMUNITY_ERASURE_JOURNAL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional()
  ),
  COMMUNITY_GOOGLE_CLIENT_ID: z.string().optional(),
  COMMUNITY_GOOGLE_CLIENT_SECRET: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_ID: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_SECRET: z.string().optional(),
  COMMUNITY_TERMS_URL: optionalText,
  COMMUNITY_PRIVACY_URL: optionalText,
  COMMUNITY_REPORT_ABUSE_URL: optionalText,
});

/** Validated deployment settings, resolved only when the server starts. */
export type CommunityConfig = ReturnType<typeof parseConfig>;

/** Parse all community settings before opening the listener or database. */
export function parseConfig(env: Record<string, unknown>) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid community configuration: ${fields}`);
  }
  const value = result.data;
  if (
    Boolean(value.COMMUNITY_INVITE_PREVIOUS_KEY_ID) !==
      Boolean(value.COMMUNITY_INVITE_PREVIOUS_SECRET) ||
    value.COMMUNITY_INVITE_PREVIOUS_KEY_ID === value.COMMUNITY_INVITE_KEY_ID
  ) {
    throw new Error(
      'Previous invite key ID and secret must be set together, with an ID different from the current key'
    );
  }
  for (const name of ['GOOGLE', 'GITHUB'] as const) {
    const id = value[`COMMUNITY_${name}_CLIENT_ID`];
    const secret = value[`COMMUNITY_${name}_CLIENT_SECRET`];
    if (Boolean(id) !== Boolean(secret)) {
      throw new Error(
        `COMMUNITY_${name}_CLIENT_ID and COMMUNITY_${name}_CLIENT_SECRET must be set together`
      );
    }
  }
  const publicUrl = new URL(value.COMMUNITY_PUBLIC_URL);
  if (
    publicUrl.protocol !== 'https:' &&
    !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(publicUrl.hostname))
  ) {
    throw new Error('COMMUNITY_PUBLIC_URL must use HTTPS, or HTTP on localhost');
  }
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new Error(
      'COMMUNITY_PUBLIC_URL must be a bare origin without credentials, path, query or fragment'
    );
  }
  if (value.COMMUNITY_ERASURE_JOURNAL && !isAbsolute(value.COMMUNITY_ERASURE_JOURNAL)) {
    throw new Error('COMMUNITY_ERASURE_JOURNAL must be an absolute path');
  }
  const storage = (() => {
    if (value.COMMUNITY_STORAGE_DRIVER === 'filesystem') {
      if (!value.COMMUNITY_STORAGE_PATH || !isAbsolute(value.COMMUNITY_STORAGE_PATH)) {
        throw new Error('COMMUNITY_STORAGE_PATH must be an absolute path for filesystem storage');
      }
      return { kind: 'filesystem' as const, directory: value.COMMUNITY_STORAGE_PATH };
    }
    if (!value.COMMUNITY_S3_BUCKET || !value.COMMUNITY_S3_REGION) {
      throw new Error('COMMUNITY_S3_BUCKET and COMMUNITY_S3_REGION are required for S3 storage');
    }
    if (
      Boolean(value.COMMUNITY_S3_ACCESS_KEY_ID) !== Boolean(value.COMMUNITY_S3_SECRET_ACCESS_KEY)
    ) {
      throw new Error(
        'COMMUNITY_S3_ACCESS_KEY_ID and COMMUNITY_S3_SECRET_ACCESS_KEY must be set together'
      );
    }
    checkS3Endpoint('COMMUNITY_S3_ENDPOINT', value.COMMUNITY_S3_ENDPOINT);
    return {
      kind: 's3' as const,
      bucket: value.COMMUNITY_S3_BUCKET,
      region: value.COMMUNITY_S3_REGION,
      endpoint: value.COMMUNITY_S3_ENDPOINT,
      accessKeyId: value.COMMUNITY_S3_ACCESS_KEY_ID,
      secretAccessKey: value.COMMUNITY_S3_SECRET_ACCESS_KEY,
    };
  })();
  const evidence = (() => {
    const driver = value.COMMUNITY_EVIDENCE_DRIVER;
    if (!driver) {
      const stray = Object.keys(value).find(
        (name) => name.startsWith('COMMUNITY_EVIDENCE_') && value[name as keyof typeof value]
      );
      if (stray) throw new Error(`${stray} is set, but COMMUNITY_EVIDENCE_DRIVER is not`);
      return null;
    }
    if (driver === 'filesystem') {
      const directory = value.COMMUNITY_EVIDENCE_PATH;
      if (!directory || !isAbsolute(directory)) {
        throw new Error(
          'COMMUNITY_EVIDENCE_PATH must be an absolute path for a filesystem evidence store'
        );
      }
      // Evidence must never be where the server serves, stages, or stores anything else: a
      // served folder would publish it, and a store or temporary folder may be swept.
      const forbidden = [
        ...(storage.kind === 'filesystem' ? [['COMMUNITY_STORAGE_PATH', storage.directory]] : []),
        ['the web app folder', SERVED_WEB_APP_DIRECTORY],
        ['the temporary folder (where file stores stage their uploads)', tmpdir()],
      ];
      for (const [name, path] of forbidden) {
        if (directoriesOverlap(directory, path)) {
          throw new Error(`COMMUNITY_EVIDENCE_PATH must not be, contain, or sit inside ${name}`);
        }
      }
      return { kind: 'filesystem' as const, directory: resolve(directory) };
    }
    if (!value.COMMUNITY_EVIDENCE_S3_BUCKET || !value.COMMUNITY_EVIDENCE_S3_REGION) {
      throw new Error(
        'COMMUNITY_EVIDENCE_S3_BUCKET and COMMUNITY_EVIDENCE_S3_REGION are required for an S3 evidence store'
      );
    }
    if (
      Boolean(value.COMMUNITY_EVIDENCE_S3_ACCESS_KEY_ID) !==
      Boolean(value.COMMUNITY_EVIDENCE_S3_SECRET_ACCESS_KEY)
    ) {
      throw new Error(
        'COMMUNITY_EVIDENCE_S3_ACCESS_KEY_ID and COMMUNITY_EVIDENCE_S3_SECRET_ACCESS_KEY must be set together'
      );
    }
    checkS3Endpoint('COMMUNITY_EVIDENCE_S3_ENDPOINT', value.COMMUNITY_EVIDENCE_S3_ENDPOINT);
    if (
      storage.kind === 's3' &&
      storage.bucket === value.COMMUNITY_EVIDENCE_S3_BUCKET &&
      (storage.endpoint ?? '') === (value.COMMUNITY_EVIDENCE_S3_ENDPOINT ?? '')
    ) {
      throw new Error(
        'The evidence store must be a different bucket from COMMUNITY_S3_BUCKET, or on a different endpoint'
      );
    }
    return {
      kind: 's3' as const,
      bucket: value.COMMUNITY_EVIDENCE_S3_BUCKET,
      region: value.COMMUNITY_EVIDENCE_S3_REGION,
      endpoint: value.COMMUNITY_EVIDENCE_S3_ENDPOINT,
      accessKeyId: value.COMMUNITY_EVIDENCE_S3_ACCESS_KEY_ID,
      secretAccessKey: value.COMMUNITY_EVIDENCE_S3_SECRET_ACCESS_KEY,
      prefix: value.COMMUNITY_EVIDENCE_S3_PREFIX,
    };
  })();
  const hostLinks = {
    termsUrl: hostLink('COMMUNITY_TERMS_URL', value.COMMUNITY_TERMS_URL),
    privacyUrl: hostLink('COMMUNITY_PRIVACY_URL', value.COMMUNITY_PRIVACY_URL),
    reportAbuseUrl: hostLink('COMMUNITY_REPORT_ABUSE_URL', value.COMMUNITY_REPORT_ABUSE_URL, true),
  };
  return {
    databaseUrl: value.COMMUNITY_DATABASE_URL,
    authSecret: value.COMMUNITY_AUTH_SECRET,
    inviteSecret: value.COMMUNITY_INVITE_SECRET,
    inviteKeyId: value.COMMUNITY_INVITE_KEY_ID,
    invitePreviousKeyId: value.COMMUNITY_INVITE_PREVIOUS_KEY_ID,
    invitePreviousSecret: value.COMMUNITY_INVITE_PREVIOUS_SECRET,
    bootstrapSecret: value.COMMUNITY_BOOTSTRAP_SECRET,
    publicUrl: publicUrl.origin,
    storage,
    /** Where takedowns copy removed content, outside the API; null when the host set none. */
    evidence,
    port: value.COMMUNITY_PORT,
    testRuntime: value.COMMUNITY_TEST_RUNTIME === 'true',
    /** Where each completed erasure's id-only line is also appended, outside the database. */
    erasureJournal: value.COMMUNITY_ERASURE_JOURNAL,
    hostLinks,
    /** The header a trusted proxy puts the caller's address in; per-caller limits read it. */
    trustedProxyHeader: value.COMMUNITY_TRUSTED_PROXY_HEADER?.toLowerCase(),
    /** Every short name no community may take: the built-in paths and this host's additions. */
    reservedShortNames: new Set([
      ...COMMUNITY_RESERVED_SHORT_NAMES,
      ...(value.COMMUNITY_RESERVED_SHORT_NAMES ?? []),
    ]),
    oauth: {
      google:
        value.COMMUNITY_GOOGLE_CLIENT_ID && value.COMMUNITY_GOOGLE_CLIENT_SECRET
          ? {
              clientId: value.COMMUNITY_GOOGLE_CLIENT_ID,
              clientSecret: value.COMMUNITY_GOOGLE_CLIENT_SECRET,
            }
          : undefined,
      github:
        value.COMMUNITY_GITHUB_CLIENT_ID && value.COMMUNITY_GITHUB_CLIENT_SECRET
          ? {
              clientId: value.COMMUNITY_GITHUB_CLIENT_ID,
              clientSecret: value.COMMUNITY_GITHUB_CLIENT_SECRET,
            }
          : undefined,
    },
    limits: {
      postsPerTenMinutes: value.COMMUNITY_POSTS_PER_TEN_MINUTES,
      agentsPerOwner: value.COMMUNITY_AGENTS_PER_OWNER,
      textBytes: value.COMMUNITY_TEXT_BYTES,
      attachmentsPerPost: value.COMMUNITY_ATTACHMENTS_PER_POST,
      attachmentBytes: value.COMMUNITY_ATTACHMENT_BYTES,
      uploadBytesPerDay: value.COMMUNITY_UPLOAD_BYTES_PER_DAY,
      signupAttemptsPerMinute: value.COMMUNITY_SIGNUP_ATTEMPTS_PER_MINUTE,
      bootstrapAttemptsPerMinute: value.COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE,
      invitePreviewAttemptsPerMinute: value.COMMUNITY_INVITE_PREVIEW_ATTEMPTS_PER_MINUTE,
      pairingAttemptsPerMinute: value.COMMUNITY_PAIRING_ATTEMPTS_PER_MINUTE,
      hostKeyAttemptsPerMinute: value.COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE,
      reauthAttemptsPerMinute: value.COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE,
      hostDeletionNoticeDays: value.COMMUNITY_HOST_DELETION_NOTICE_DAYS,
      shortNameCooloffDays: value.COMMUNITY_SHORT_NAME_COOLOFF_DAYS,
      nameLookupsPerMinute: value.COMMUNITY_NAME_LOOKUPS_PER_MINUTE,
      takedownEvidenceAlertHours: value.COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS,
    },
  };
}
