/**
 * The extension-building case (DOR-2858): asked in plain words for a DorkOS
 * extension with its own small API, does an agent build a server half that
 * actually compiles, starts and answers?
 *
 * It was built to compare the two ways an extension's server half could serve
 * HTTP before DorkOS dropped the Express router (DOR-2861): a router
 * (`register(router, ctx)` added routes) and a fetch handler (a Hono app
 * returned as `{ fetch }`). It now guards the one way. The prompt never names
 * either, so what the `data-provider` template and the `get_extension_api`
 * text teach was the only thing that changed between the runs below.
 *
 * **Why the approval is seeded, not decided.** A server half runs only after a
 * person approves that copy of the extension (`extension-load-policy.ts`): its id
 * in `extensions.approvedToRun` and its directory in `extensions.approvedSources`.
 * The directory is known before the extension exists, because `create_extension`
 * writes to `{dorkHome}/extensions/<id>` unless told to use the project, so the
 * seed writes the approval into the sandbox `config.json` before the server
 * boots. That is the record a person clicking Approve would leave, and it keeps
 * the measured turn about building, not about an approval card. An agent that
 * scaffolds into the project instead (`scope: local`) builds a copy nobody
 * approved, and the server rightly refuses to start it: the start oracle goes
 * red and its evidence names the refusal.
 *
 * **What the oracles read** (outcomes only, in order, against the running server):
 * 1. `server.ts` exists where `create_extension` writes it;
 * 2. `POST /api/extensions/quote-board/init-server` answers `{ ok: true }` — the
 *    server half compiled and started (idempotent: a server half the agent's own
 *    reload already started answers the same). A compile error comes back as the
 *    `error` text, which is the evidence a failure needs;
 * 3. `GET /api/ext/quote-board/quotes` answers 200 with `quotes` holding at least
 *    two strings;
 * 4. the same `PUT` sent as an agent (`x-dorkos-agent`) is refused with 403. The
 *    `/api` chain refuses nothing on that header, so a 403 can only come from the
 *    extension itself (`requirePerson()`);
 * 5. the `PUT` sent as the person (no agent header; a credentialed eval server
 *    runs with login off, where that caller is the local operator) succeeds;
 * 6. a second `GET` returns exactly the list the person saved, so "saves" means
 *    saved, not merely answered.
 *
 * **Credentialed and quarantined.** `claude-code-cheap` only: on a `test-mode`
 * run it reports `skipped-wrong-tier`, since a scripted runtime builds nothing.
 * Tagged `experimental` and never `core`, so it spends only on
 * `--suite extension-data-provider` or `--suite experimental`.
 *
 * **The drill** (README "A new oracle ships with a drill"): the request oracle
 * has a deterministic PASS and FAIL in `oracles/__tests__/api.test.ts`, and the
 * case's predicates in `suite/__tests__/extensions.test.ts`. The live drill:
 * add "Do not refuse agents on the PUT" to the prompt and run
 * `pnpm evals:local --suite extension-data-provider --budget 1.50`; the
 * agent-refused oracle should be the red one.
 *
 * **Results, 2026-10-14 (UTC), haiku-4-5, the local Claude sign-in, 3 runs per
 * arm, outcomes from `results.json`:**
 *
 * | Arm | Template                                  | Passed | Cost    | Shape the agent wrote          |
 * | --- | ----------------------------------------- | ------ | ------- | ------------------------------ |
 * | A   | Express router, no person check shown     | 1 of 3 | $0.3965 | router; agent checks hand-made |
 * | B   | Express router, `ctx.requirePerson` shown | 3 of 3 | $0.3673 | router + `ctx.requirePerson`   |
 * | C   | Hono app, `requirePerson()` shown         | 3 of 3 | $0.3755 | Hono + `requirePerson()`       |
 *
 * Every run in every arm built, started and served the quotes; the only red
 * was arm A's agent-refused oracle, where agents guessed a header
 * (`x-agent-id`, a User-Agent match) and let the agent's PUT through. No run
 * in any arm called `get_extension_api`: agents edit the scaffolded template,
 * so what the template shows is what they build. The router and Hono
 * templates did equally well once both showed the person check; arm C
 * tripped on nothing (Hono import, `c.req.json`, `requirePerson()` import and
 * the unused `_router` parameter all came through as the template had them).
 * One earlier run, before the in-session extension tools were wired (DOR-2928),
 * could not reach `create_extension` at all and failed every oracle ($0.4755).
 *
 * @module evals/suite/extensions/data-provider
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileExists, httpGetAssert, httpRequestAssert } from '../../oracles/index.js';
import type { EvalCase, EvalSandbox } from '../../types.js';

/** The extension id the prompt asks for. */
export const QUOTE_BOARD_ID = 'quote-board';

/** The extension's API mount, as the person's app would call it. */
const QUOTES_PATH = `/api/ext/${QUOTE_BOARD_ID}/quotes`;

/** The list the oracles save as the person, then read back. */
export const SAVED_QUOTES = ['Eval quote one.', 'Eval quote two.', 'Eval quote three.'];

/** Where `create_extension` writes an extension at its default (global) scope. */
export const quoteBoardDir = (sandbox: EvalSandbox): string =>
  path.join(sandbox.dorkHome, 'extensions', QUOTE_BOARD_ID);

/**
 * Seed the person's approval for the copy `create_extension` will write, so its
 * server half may run once it exists. Every `extensions` field is written, not
 * just the two that matter: opening the config store does not merge nested
 * defaults into an `extensions` section that is already there.
 *
 * @param sandbox - The fresh eval sandbox.
 */
export async function seedQuoteBoardApproval(sandbox: EvalSandbox): Promise<void> {
  await mkdir(sandbox.dorkHome, { recursive: true });
  const config = {
    extensions: {
      enabled: [],
      disabled: [],
      approvedToRun: [QUOTE_BOARD_ID],
      approvedSources: { [QUOTE_BOARD_ID]: { path: quoteBoardDir(sandbox) } },
      approvedPermissions: {},
      dismissedApprovals: {},
      trustedSources: [],
    },
  };
  await writeFile(
    path.join(sandbox.dorkHome, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8'
  );
}

/**
 * Whether a body is `{ quotes: [...] }` with at least `min` strings in it.
 *
 * @param body - The parsed response body.
 * @param min - The fewest quotes that count.
 */
export function hasQuotes(body: unknown, min: number): boolean {
  const quotes = (body as { quotes?: unknown } | null | undefined)?.quotes;
  return (
    Array.isArray(quotes) &&
    quotes.length >= min &&
    quotes.every((q) => typeof q === 'string' && q.trim().length > 0)
  );
}

/**
 * Whether a body is `{ quotes: [...] }` holding exactly {@link SAVED_QUOTES}.
 *
 * @param body - The parsed response body.
 */
export function hasSavedQuotes(body: unknown): boolean {
  const quotes = (body as { quotes?: unknown } | null | undefined)?.quotes;
  return (
    Array.isArray(quotes) &&
    quotes.length === SAVED_QUOTES.length &&
    quotes.every((q, i) => q === SAVED_QUOTES[i])
  );
}

/**
 * Whether the init route said the server half started.
 *
 * @param body - The parsed response body.
 */
export function startedOk(body: unknown): boolean {
  return (body as { ok?: unknown } | null | undefined)?.ok === true;
}

/**
 * The prompt, written the way a founder would ask. It must not name the router
 * or Hono: the template and API text are what is being compared.
 */
const PROMPT =
  `Build me a DorkOS extension with the id \`${QUOTE_BOARD_ID}\`. Use the create_extension ` +
  'tool with the data-provider template. Its server side should do two things:\n\n' +
  `- \`GET ${QUOTES_PATH}\` returns JSON like \`{ "quotes": [...] }\` with at least two quotes, ` +
  'each a plain string.\n' +
  `- \`PUT ${QUOTES_PATH}\` takes JSON \`{ "quotes": [...] }\` and saves it as the new list, ` +
  'so the next GET returns it. Only people may change the list: if an agent calls it, ' +
  'refuse.\n\n' +
  'Make sure it builds and works before you finish. You can use the extension test and ' +
  'reload tools.';

/** The tools the build legitimately needs. `Bash` is left out, so it is denied. */
const BUILD_TOOLS = [
  'create_extension',
  'get_extension_api',
  'list_extensions',
  'get_extension_errors',
  'reload_extensions',
  'test_extension',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
];

/** `extension-data-provider` — build a data-provider extension whose API answers. */
export const extensionDataProviderCase: EvalCase = {
  id: 'extension-data-provider',
  title: 'Extensions — the agent builds a data-provider whose server half answers',
  prompt: PROMPT,
  runtimeTier: 'claude-code-cheap',
  costClass: 'standard',
  tags: ['experimental'],
  quarantined: true,
  perEvalCeilingUsd: 1.5,
  // Scaffold, read the API, edit two files, compile, reload: several tool calls
  // deep, past the 90-second default on a cheap model.
  turnTimeoutMs: 300_000,
  seed: seedQuoteBoardApproval,
  approvalPolicy: { allowTools: BUILD_TOOLS },
  oracles: [
    fileExists(
      (sandbox) => path.join(quoteBoardDir(sandbox), 'server.ts'),
      'the extension server half exists where create_extension writes it'
    ),
    httpRequestAssert(
      { method: 'POST', path: `/api/extensions/${QUOTE_BOARD_ID}/init-server` },
      { status: 200, body: startedOk },
      'the server half compiles and starts'
    ),
    httpGetAssert(
      QUOTES_PATH,
      { status: 200, body: (b) => hasQuotes(b, 2) },
      'GET quotes answers with at least two quote strings'
    ),
    httpRequestAssert(
      {
        method: 'PUT',
        path: QUOTES_PATH,
        headers: { 'x-dorkos-agent': 'eval-agent' },
        json: { quotes: ['An agent wrote this.', 'And this.'] },
      },
      { status: 403 },
      'PUT quotes refuses an agent'
    ),
    httpRequestAssert(
      { method: 'PUT', path: QUOTES_PATH, json: { quotes: SAVED_QUOTES } },
      { status: [200, 201, 204] },
      'PUT quotes saves a list for a person'
    ),
    httpGetAssert(
      QUOTES_PATH,
      { status: 200, body: hasSavedQuotes },
      'GET quotes returns the list the person saved'
    ),
  ],
};

/** Every case in the extensions suite. */
export const extensionCases: EvalCase[] = [extensionDataProviderCase];
