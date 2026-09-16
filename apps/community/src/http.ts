import { ZodError, type ZodType } from 'zod';
import type { Context } from 'hono';
import { CommunityWireErrorSchema, type CommunityWireError } from '@dorkos/shared/community-wire';

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
