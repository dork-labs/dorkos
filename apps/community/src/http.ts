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

/** The longest one request may take to arrive: time for a 1 GiB export on a slow link. */
export const REQUEST_TIMEOUT_MS = 3 * 60 * 60_000;

/**
 * Let one request take up to {@link REQUEST_TIMEOUT_MS} to arrive. Node's default of five
 * minutes cuts off an export upload part-way. Headers must still arrive within Node's own
 * header timeout, JSON bodies are bounded in size before they are read, and an export upload
 * is dropped as soon as it goes a minute without a byte, so the long ceiling only ever helps
 * a request that keeps sending.
 */
export function configureServerTimeouts(server: object): void {
  if ('requestTimeout' in server) server.requestTimeout = REQUEST_TIMEOUT_MS;
}
