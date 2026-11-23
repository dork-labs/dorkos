import { BoundaryError } from '../lib/boundary.js';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { logger } from '../lib/logger.js';
import { OriginRefusedError } from '../http/cors-policy.js';
import {
  AmbiguousSessionError,
  SessionDiscoveryUnavailableError,
} from '../services/session/resolution/session-lookup-error.js';
import { RuntimeNotRegisteredError } from '../services/core/runtime-registry.js';
import { redactLogPath } from './request-logger.js';
import { problemBody, type ProblemOptions } from '@dorkos/http-kit';
import type { Problem, ProblemCode } from '@dorkos/shared/problem';

/** The status and problem document an unhandled request error is answered with. */
export interface ErrorReply {
  /** The HTTP status. */
  status: number;
  /** The problem document (`@dorkos/shared/problem`). */
  body: Problem;
}

/**
 * Log an error no route handled, with the request it broke.
 *
 * Written by the chain's `onError` (`http/api-chain.ts`). A video link's
 * ticket is written as `[ticket]` (DOR-4321).
 *
 * @param err - The error.
 * @param method - The request method.
 * @param sentPath - The request path, without the query string (as routing decoded it).
 */
export function logRequestError(err: Error, method: string, sentPath: string): void {
  const path = redactLogPath(sentPath);
  // A refused browser origin is the caller's mistake, not a fault to page on.
  if (err instanceof OriginRefusedError) {
    logger.warn('[CORS] refused origin', { origin: err.origin, method, path });
    return;
  }
  const code = (err as { code?: unknown }).code;
  const status = (err as { status?: unknown }).status;
  logger.error('[DorkOS Error]', err.message, {
    method,
    path,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    stack: err.stack,
  });
}

/**
 * How an error no route handled is answered: which status, and which problem
 * document (`application/problem+json`, DOR-4979).
 *
 * One mapping for every route, so they all fail the same way. A server fault's
 * own message rides as `detail` outside production only.
 *
 * @param err - The error.
 * @returns The status and body to answer with.
 */
export function errorReply(err: Error): ErrorReply {
  const reply = (code: ProblemCode, options: ProblemOptions = {}): ErrorReply => {
    const body = problemBody(code, options);
    return { status: body.status, body };
  };
  // A runtime registration mismatch is a configuration error, not a 500. A
  // session persisted as runtime X on a server that no longer has X registered
  // is deployment drift; surface it with a stable error code so the client can
  // render a targeted message instead of a generic failure toast.
  //
  // The relay's own version of this no longer arrives here. It is answered where
  // it happens — the built-in adapter refuses the delivery by name and reports
  // it on the adapter status (DOR-1614) — because it belongs to a bus message,
  // not to an HTTP request there is a response to write.
  //
  // **The words say what a room's `runtime_gone` notice says** (DOR-1720). This
  // is the same state reached from the other surface — a conversation pinned to
  // a program that is not running — and the two used to describe it in different
  // languages: one named a runtime slug and stopped there, the other apologised
  // for a broken agent. Naming the program the way a person sees it elsewhere
  // (`runtimeDisplayName`) and stating the recovery is what makes them one
  // answer.
  if (err instanceof BoundaryError) {
    return err.code === 'OUTSIDE_BOUNDARY'
      ? reply('outside_boundary', { detail: 'This chat is outside the allowed directory.' })
      : reply('forbidden', { detail: err.message });
  }

  if (err instanceof OriginRefusedError) {
    return reply('origin_not_allowed', { detail: err.message });
  }

  if (err instanceof SessionDiscoveryUnavailableError) {
    return reply('temporarily_unavailable', { detail: err.message });
  }

  if (err instanceof AmbiguousSessionError) {
    return reply('conflict', { detail: err.message });
  }

  if (err instanceof RuntimeNotRegisteredError) {
    const program = runtimeDisplayName(err.runtime);
    return reply('runtime_not_available', {
      detail: `This chat runs on ${program}, which isn't running on this machine. Turn ${program} back on to pick it up, or start a new chat to use what's running now.`,
    });
  }

  // A body the chain's reader refused is the caller's mistake, never a server
  // fault: answering 500 to one told a person saving a large file in a room
  // that the server broke (DOR-1600's review), and told a script that sent
  // broken JSON the same (DOR-4979). `body-parser` marks each refusal with a
  // `type`; the ones it raises for a body it could not read map here.
  const type = (err as { type?: unknown }).type;
  const bodyRefusal =
    typeof type === 'string' && Object.hasOwn(BODY_REFUSALS, type)
      ? BODY_REFUSALS[type]
      : undefined;
  if (bodyRefusal) return reply(bodyRefusal.code, { detail: bodyRefusal.detail });

  // eslint-disable-next-line no-restricted-syntax -- must read dynamically; env.ts parses once at import and tests mutate NODE_ENV at runtime
  const isDev = process.env.NODE_ENV !== 'production';
  return reply('internal_error', isDev && err.message ? { detail: err.message } : {});
}

/** The `body-parser` refusals the chain answers as the caller's mistake, by its `type`. */
const BODY_REFUSALS: Readonly<Record<string, { code: ProblemCode; detail: string }>> = {
  'entity.too.large': {
    code: 'request_too_large',
    detail: 'That is too large to send in one request.',
  },
  'entity.parse.failed': {
    code: 'malformed_request',
    detail: 'The request body is not valid JSON.',
  },
  'request.aborted': {
    code: 'malformed_request',
    detail: 'The request body ended before it was complete.',
  },
  'request.size.invalid': {
    code: 'malformed_request',
    detail: 'The request body is not the size it said it was.',
  },
  'encoding.unsupported': {
    code: 'unsupported_media_type',
    detail: 'The request body is compressed in a way DorkOS cannot read.',
  },
  'charset.unsupported': {
    code: 'unsupported_media_type',
    detail: 'The request body uses a character set DorkOS cannot read.',
  },
};
