import { z } from 'zod';
import { isAbsolute } from 'node:path';

const integer = (name: string, fallback: number, ceiling: number) =>
  z.coerce.number().int().min(1, `${name} must be positive`).max(ceiling).default(fallback);

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
  COMMUNITY_PORT: integer('COMMUNITY_PORT', 6481, 65535),
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
  COMMUNITY_GOOGLE_CLIENT_ID: z.string().optional(),
  COMMUNITY_GOOGLE_CLIENT_SECRET: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_ID: z.string().optional(),
  COMMUNITY_GITHUB_CLIENT_SECRET: z.string().optional(),
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
    if (value.COMMUNITY_S3_ENDPOINT) {
      const endpoint = new URL(value.COMMUNITY_S3_ENDPOINT);
      if (
        endpoint.protocol !== 'https:' &&
        !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))
      ) {
        throw new Error('COMMUNITY_S3_ENDPOINT must use HTTPS, or HTTP on localhost');
      }
      if (endpoint.username || endpoint.password) {
        throw new Error('COMMUNITY_S3_ENDPOINT must not contain credentials');
      }
    }
    return {
      kind: 's3' as const,
      bucket: value.COMMUNITY_S3_BUCKET,
      region: value.COMMUNITY_S3_REGION,
      endpoint: value.COMMUNITY_S3_ENDPOINT,
      accessKeyId: value.COMMUNITY_S3_ACCESS_KEY_ID,
      secretAccessKey: value.COMMUNITY_S3_SECRET_ACCESS_KEY,
    };
  })();
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
    port: value.COMMUNITY_PORT,
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
    },
  };
}
