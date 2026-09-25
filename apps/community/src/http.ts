import { ZodError, type ZodType, type output } from 'zod';
import type { Context } from 'hono';
import { CommunityWireErrorSchema, type CommunityWireError } from '@dorkos/shared/community-wire';

import { CommunityAdminSettingsConflictSchema } from '@dorkos/shared/community-admin-wire';

type Code = CommunityWireError['code'];

/** Expected API refusal with stable public code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: Code,
    message: string
  ) {
    super(message);
  }
}

/**
 * A rolling-window limit was reached: `429 RATE_LIMITED` with a `Retry-After` header, so a client
 * knows how long to wait instead of guessing.
 */
export class RateLimited extends ApiError {
  constructor(
    message: string,
    /** Whole seconds until the window frees an attempt, at least 1. */
    public readonly retryAfterSeconds: number
  ) {
    super(429, 'RATE_LIMITED', message);
  }
}

/** An authorized administrative edit conflicted with the current safe settings. */
export class AdminSettingsConflict extends ApiError {
  constructor(
    public readonly current: output<typeof CommunityAdminSettingsConflictSchema>['current']
  ) {
    super(
      409,
      'STATE_CONFLICT',
      'Community settings changed. Review the current values and try again.'
    );
  }
}

/** Read a JSON body through the shared wire schema. */
export async function readJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'STATE_CONFLICT', 'A JSON body is required.');
  }
  return schema.parse(body);
}

/** Serialize only fields allowed by a public wire schema. */
export function json<T>(c: Context, schema: ZodType<T>, value: T, status = 200): Response {
  return c.json(schema.parse(value), status as 200);
}

/** Map expected failures to the shared public error shape. */
export function handleError(error: unknown, c: Context): Response {
  if (error instanceof AdminSettingsConflict) {
    c.header('ETag', `"${error.current.settingsVersion}"`);
    c.header('Cache-Control', 'no-store');
    return c.json(
      CommunityAdminSettingsConflictSchema.parse({
        code: error.code,
        message: error.message,
        current: error.current,
      }),
      409
    );
  }
  if (error instanceof ApiError) {
    if (error instanceof RateLimited) c.header('Retry-After', String(error.retryAfterSeconds));
    return c.json(
      CommunityWireErrorSchema.parse({ code: error.code, message: error.message }),
      error.status as 400
    );
  }
  if (error instanceof ZodError) {
    return c.json(
      CommunityWireErrorSchema.parse({
        code: 'STATE_CONFLICT',
        message: 'The request is invalid.',
      }),
      400
    );
  }
  console.error(
    'Community request failed',
    error instanceof Error ? error.message : 'Unknown error'
  );
  return c.json(
    CommunityWireErrorSchema.parse({
      code: 'UNAVAILABLE',
      message: 'The community is unavailable.',
    }),
    503
  );
}
