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
const between = (floor: number, fallback: number, ceiling: number) =>
  z.coerce.number().int().min(floor).max(ceiling).default(fallback);

const MIB = 1024 * 1024;

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

/** One configured OpenID Connect issuer: the host's own single sign-on, beside passwords. */
export type CommunityOidcConfig = {
  /** The issuer, without a trailing slash; discovery is `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Sign-in button text. */
  label: string;
  scopes: string[];
};

// RFC 6749 section 3.3 scope-token characters.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

/**
 * Read the OpenID Connect settings: all of issuer, client ID and client secret, or none of them.
 * The label and scopes are optional and only allowed alongside an issuer.
 */
function parseOidc(value: {
  COMMUNITY_OIDC_ISSUER_URL?: string;
  COMMUNITY_OIDC_CLIENT_ID?: string;
  COMMUNITY_OIDC_CLIENT_SECRET?: string;
  COMMUNITY_OIDC_LABEL?: string;
  COMMUNITY_OIDC_SCOPES?: string;
}): CommunityOidcConfig | null {
  const {
    COMMUNITY_OIDC_ISSUER_URL: issuerUrl,
    COMMUNITY_OIDC_CLIENT_ID: clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: clientSecret,
    COMMUNITY_OIDC_LABEL: label,
    COMMUNITY_OIDC_SCOPES: scopes,
  } = value;
  if (!issuerUrl && !clientId && !clientSecret) {
    if (label || scopes)
      throw new Error(
        'COMMUNITY_OIDC_LABEL and COMMUNITY_OIDC_SCOPES need COMMUNITY_OIDC_ISSUER_URL, COMMUNITY_OIDC_CLIENT_ID and COMMUNITY_OIDC_CLIENT_SECRET'
      );
    return null;
  }
  if (!issuerUrl || !clientId || !clientSecret)
    throw new Error(
      'COMMUNITY_OIDC_ISSUER_URL, COMMUNITY_OIDC_CLIENT_ID and COMMUNITY_OIDC_CLIENT_SECRET must be set together'
    );
  let issuer: URL;
  try {
    issuer = new URL(issuerUrl);
  } catch (cause) {
    throw new Error('COMMUNITY_OIDC_ISSUER_URL must be an https:// address', { cause });
  }
  if (
    issuer.protocol !== 'https:' &&
    !(issuer.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(issuer.hostname))
  )
    throw new Error('COMMUNITY_OIDC_ISSUER_URL must use HTTPS, or HTTP on localhost');
  if (issuer.username || issuer.password || issuer.search || issuer.hash)
    throw new Error(
      'COMMUNITY_OIDC_ISSUER_URL must not contain credentials, a query or a fragment'
    );
  const buttonLabel = label?.trim() ?? 'Single sign-on';
  if (buttonLabel.length < 1 || buttonLabel.length > 40)
    throw new Error('COMMUNITY_OIDC_LABEL must be 1 to 40 characters');
  const scopeList = (scopes ?? 'openid email profile').split(/\s+/u).filter(Boolean);
  if (
    !scopeList.includes('openid') ||
    scopeList.length > 16 ||
    scopeList.some((scope) => !SCOPE_TOKEN.test(scope))
  )
    throw new Error('COMMUNITY_OIDC_SCOPES must be space-separated scopes that include openid');
  return {
    issuer: issuer.href.replace(/\/+$/u, ''),
    clientId,
    clientSecret,
    label: buttonLabel,
    scopes: [...new Set(scopeList)],
  };
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

/** Where and how the Community hands mail to the host's own SMTP server. */
export type CommunityMailConfig = {
  smtp: {
    host: string;
    port: number;
    /** Implicit TLS from the first byte (`smtps:`). */
    secure: boolean;
    /** Refuse to send unless the server upgrades the connection with STARTTLS. */
    requireTLS: boolean;
    auth: { user: string; pass: string } | null;
  };
  /** The sender every notice carries, from `COMMUNITY_MAIL_FROM`. */
  from: { name: string | null; address: string };
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const EMAIL = z.email();

/**
 * Read the one RFC 5322 mailbox notices come from: `notices@example.com` or
 * `Example Community <notices@example.com>`. A line break, a second address, or a group is
 * refused, so the setting can never add a header.
 */
function parseMailFrom(value: string): CommunityMailConfig['from'] {
  const invalid = () =>
    new Error(
      'COMMUNITY_MAIL_FROM must be one mailbox, such as notices@example.com or Example <notices@example.com>'
    );
  if (/[\p{Cc}]/u.test(value)) throw invalid();
  const named = /^\s*(?:"([^"\\]{1,80})"|([^"<>,;:@\\]{1,80}?))\s*<([^<>\s]+)>\s*$/u.exec(value);
  const address = named ? named[3] : value.trim();
  if (!EMAIL.safeParse(address).success) throw invalid();
  const name = named ? (named[1] ?? named[2]).trim() : '';
  return { name: name || null, address };
}

/**
 * Read the mail settings: `COMMUNITY_SMTP_URL` and `COMMUNITY_MAIL_FROM` together, or neither.
 * Off loopback the connection must be encrypted: `smtps://` (TLS from the start), or `smtp://`
 * with `?starttls=required`. Credentials, if any, go in the URL and are percent-decoded.
 */
function parseMail(value: {
  COMMUNITY_SMTP_URL?: string;
  COMMUNITY_MAIL_FROM?: string;
}): CommunityMailConfig | null {
  const { COMMUNITY_SMTP_URL: smtpUrl, COMMUNITY_MAIL_FROM: mailFrom } = value;
  if (!smtpUrl && !mailFrom) return null;
  if (!smtpUrl || !mailFrom)
    throw new Error('COMMUNITY_SMTP_URL and COMMUNITY_MAIL_FROM must be set together');
  const shape = 'COMMUNITY_SMTP_URL must be smtps://host[:port] or smtp://host[:port]';
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Node's URL error carries the input, password and all.
    throw new Error(shape);
  }
  if ((url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname)
    throw new Error(shape);
  if ((url.pathname !== '' && url.pathname !== '/') || url.hash)
    throw new Error(`${shape}, with no path or fragment`);
  const query = [...url.searchParams.entries()];
  const starttls = query.length === 1 && query[0][0] === 'starttls' && query[0][1] === 'required';
  if (query.length && (!starttls || url.protocol !== 'smtp:'))
    throw new Error('COMMUNITY_SMTP_URL takes one option only: ?starttls=required on smtp://');
  const secure = url.protocol === 'smtps:';
  if (url.port === '0') throw new Error('COMMUNITY_SMTP_URL must not use port 0');
  const plain = !secure && !starttls;
  // For an unencrypted relay `localhost` means the IPv4 loopback address, never whatever a
  // resolver answers for it, so the no-encryption exemption can only ever reach this machine.
  const lowered = url.hostname.toLowerCase();
  const hostname = plain && lowered === 'localhost' ? '127.0.0.1' : lowered;
  if (plain && !LOOPBACK_HOSTS.has(hostname))
    throw new Error(
      'COMMUNITY_SMTP_URL must encrypt mail off this machine: use smtps://, or smtp:// with ?starttls=required'
    );
  if (Boolean(url.username) !== Boolean(url.password))
    throw new Error('COMMUNITY_SMTP_URL must carry both a user name and a password, or neither');
  let auth: CommunityMailConfig['smtp']['auth'] = null;
  if (url.username) {
    try {
      auth = { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) };
    } catch {
      // eslint-disable-next-line preserve-caught-error -- the cause would name the encoded password.
      throw new Error('COMMUNITY_SMTP_URL has a badly encoded user name or password');
    }
  }
  return {
    smtp: {
      host: hostname.replace(/^\[(.*)\]$/u, '$1'),
      port: url.port ? Number(url.port) : secure ? 465 : starttls ? 587 : 25,
      secure,
      requireTLS: starttls,
      auth,
    },
    from: parseMailFrom(mailFrom),
  };
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
  COMMUNITY_EXPORT_SEGMENT_BYTES: between(64 * MIB, 256 * MIB, 1024 * MIB),
  COMMUNITY_EXPORT_TTL_HOURS: between(1, 24, 168),
  COMMUNITY_EXPORT_MAX_HOURS: between(1, 24, 168),
  COMMUNITY_EXPORT_CONCURRENCY: between(1, 1, 8),
  COMMUNITY_IMPORT_UPLOADS: integer('COMMUNITY_IMPORT_UPLOADS', 2, 16),
  COMMUNITY_ERASURE_JOURNAL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional()
  ),
  COMMUNITY_GOOGLE_CLIENT_ID: z.string().optional(),
  COMMUNITY_GOOGLE_CLIENT_SECRET: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_ID: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_SECRET: z.string().optional(),
  COMMUNITY_OIDC_ISSUER_URL: optionalText,
  COMMUNITY_OIDC_CLIENT_ID: optionalText,
  COMMUNITY_OIDC_CLIENT_SECRET: optionalText,
  COMMUNITY_OIDC_LABEL: optionalText,
  COMMUNITY_OIDC_SCOPES: optionalText,
  COMMUNITY_SMTP_URL: optionalText,
  COMMUNITY_MAIL_FROM: optionalText,
  // Owner replacement: the wait after a notice reaches the owner, the longer wait when it may
  // not have, and how long a host must wait to ask again after the owner said no.
  COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: between(7, 14, 90),
  COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: between(14, 30, 180),
  COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS: between(30, 90, 365),
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
  const oidc = parseOidc(value);
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
  const mail = parseMail(value);
  if (
    value.COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS <
    value.COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS
  ) {
    throw new Error(
      'COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS must not be shorter than COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS'
    );
  }
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
    /** Background exports: segment size, archive lifetime, per-job deadline, jobs per replica. */
    exports: {
      segmentBytes: value.COMMUNITY_EXPORT_SEGMENT_BYTES,
      ttlHours: value.COMMUNITY_EXPORT_TTL_HOURS,
      maxHours: value.COMMUNITY_EXPORT_MAX_HOURS,
      concurrency: value.COMMUNITY_EXPORT_CONCURRENCY,
    },
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
    oidc,
    /** The host's SMTP server and sender, or `null`: then the Community sends no mail at all. */
    mail,
    /** Owner-replacement waits, in days. */
    ownerReplacement: {
      noticeDays: value.COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS,
      unreachableDays: value.COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS,
      objectionCooldownDays: value.COMMUNITY_OWNER_REPLACEMENT_OBJECTION_COOLDOWN_DAYS,
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
      /** Export uploads one replica receives at once; each can stage up to twice its size. */
      importUploads: value.COMMUNITY_IMPORT_UPLOADS,
      takedownEvidenceAlertHours: value.COMMUNITY_TAKEDOWN_EVIDENCE_ALERT_HOURS,
    },
  };
}
