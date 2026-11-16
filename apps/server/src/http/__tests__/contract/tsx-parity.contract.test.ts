/**
 * The real-ESM guard for the contract bundle (DOR-4190).
 *
 * Every other contract file boots this run's esbuild bundle of the server
 * (`server-build.ts`). A bundle turns top-level `const`, `let` and `class` into
 * hoisted bindings, so an import cycle that reads a binding before it is set,
 * which throws `Cannot access X before initialization` under Node's own ES
 * modules, reads `undefined` in the bundle and may boot fine. This file boots
 * the server once the way it really runs, `tsx src/index.ts`, and checks it
 * answers, so a server that crashes at import time fails the suite.
 */
import { HealthResponseSchema } from '@dorkos/shared/schemas';
import { contractSuite, SERVER_ORIGIN } from './harness.js';

contractSuite(
  'tsx parity (real ES modules)',
  [
    {
      name: 'GET /api/health answers the HealthResponse',
      path: '/api/health',
      expect: { status: 200, schema: HealthResponseSchema },
    },
    {
      name: 'the first sign-up creates the owner and signs them in',
      method: 'POST',
      path: '/api/auth/sign-up/email',
      headers: { origin: SERVER_ORIGIN },
      body: {
        email: 'owner' + '@' + 'dork.test',
        password: 'correct-horse-battery-staple',
        name: 'Owner',
      },
      expect: {
        status: 200,
        headers: { 'set-cookie': /^better-auth[-0-9a-f]*\.session_token=/i },
      },
    },
  ],
  { tsx: true }
);
