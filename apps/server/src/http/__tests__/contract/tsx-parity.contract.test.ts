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
 *
 * It checks one refusal too. A gate whose check reads a binding a cycle left
 * unset could let everyone through in the bundle and still boot, so the same
 * boot asks the A2A gateway with no credential and must be turned away, with
 * the 401 `a2a-groups.contract.test.ts` expects for that case.
 */
import { HealthResponseSchema } from '@dorkos/shared/schemas';
import { z } from 'zod';
import { contractSuite, SERVER_ORIGIN } from './harness.js';

/** The login-off A2A 401, as `a2a-groups.contract.test.ts` asserts it. */
const NEEDS_LOCAL_TOKEN = z
  .object({
    jsonrpc: z.literal('2.0'),
    error: z
      .object({
        code: z.literal(-32001),
        message: z
          .string()
          .regex(
            /^Unauthorized\. This agent-to-agent call needs your local MCP token\. Find it in Settings → Advanced → Tools → Connect other apps to DorkOS, or in .+mcp-local-token, and send it as "Authorization: Bearer <token>"\.$/
          )
          .refine((message) => !message.includes('dork_mcp_local_'), 'echoes the token'),
      })
      .strict(),
    id: z.null(),
  })
  .strict();

contractSuite(
  'tsx parity (real ES modules)',
  [
    {
      name: 'GET /api/health answers the HealthResponse',
      path: '/api/health',
      expect: { status: 200, schema: HealthResponseSchema },
    },
    {
      name: 'POST /a2a with no credential is refused before it reaches an agent',
      method: 'POST',
      path: '/a2a',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm-parity-refused',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          },
        },
      },
      expect: {
        status: 401,
        headers: {
          'content-type': /^application\/json\b/,
          'x-content-type-options': 'nosniff',
          'ratelimit-limit': null,
        },
        schema: NEEDS_LOCAL_TOKEN,
      },
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
