import type { Server } from 'node:http';
import supertest from 'supertest';

export type { Response, Test } from 'supertest';

const LISTENER_GUIDANCE =
  'Use listeningServer() or swappableServer() and pass the returned listening http.Server.';

/**
 * Create a Supertest request builder for an already-listening server or an
 * explicit HTTP URL.
 *
 * @param target - A listening HTTP server or an absolute HTTP(S) URL.
 * @returns Supertest's chainable request builder.
 * @throws When the target is not an explicit HTTP(S) URL or an already-listening Server.
 */
export default function request(target: Server | string): ReturnType<typeof supertest> {
  if (typeof target === 'string') {
    let url: URL;
    try {
      url = new URL(target);
    } catch (error) {
      throw new TypeError(
        `Supertest URL targets must begin with http:// or https://. ${LISTENER_GUIDANCE}`,
        { cause: error }
      );
    }

    if (!/^https?:\/\//.test(target) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new TypeError(
        `Supertest URL targets must begin with http:// or https://. ${LISTENER_GUIDANCE}`
      );
    }

    return supertest(target);
  }

  const candidate: unknown = target;
  if (typeof candidate === 'function') {
    throw new TypeError(
      `Supertest cannot accept a callable Express app because that creates an implicit listener. ${LISTENER_GUIDANCE}`
    );
  }

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('listening' in candidate) ||
    candidate.listening !== true ||
    !('address' in candidate) ||
    typeof candidate.address !== 'function' ||
    candidate.address() === null
  ) {
    throw new TypeError(
      `Supertest requires an already-listening http.Server. ${LISTENER_GUIDANCE}`
    );
  }

  return supertest(target);
}
