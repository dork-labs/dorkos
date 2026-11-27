import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';
import spaces from './eslint-rules/space-boundary.js';
import workGraph from './eslint-rules/work-graph-boundary.js';
import sessionRuntimes from './eslint-rules/session-runtimes-boundary.js';
import problemOnly from './eslint-rules/problem-only.js';
import turnPort from './eslint-rules/turn-port-boundary.js';
import computerWall from './eslint-rules/computer-wall.js';
import importBoundary from './eslint-rules/import-boundary.js';
import { routesImportBlocks } from './eslint-rules/routes-imports.js';

// Services never import middleware (DOR-4922): a middleware step calls a service,
// never the reverse. A service that needs a step's function declares the function
// type it needs, and its composition root passes the step's function in; a pure
// helper both need lives in `lib/`. The pattern sees the specifier, not the
// resolved path, so it refuses a climb of two or more `../` into a folder named
// `middleware`: from `services/<domain>/` that is the top-level `src/middleware/`.
// It rides `@typescript-eslint/no-restricted-imports`, a rule no other block sets,
// so the many blocks that restate `no-restricted-imports` need not carry it.
const MIDDLEWARE_BAN = {
  regex: '^(?:\\.\\./){2,}middleware(?:/|$)',
  message:
    "A service never imports middleware (DOR-4922). Declare the function type it needs and have its composition root pass the step's function in, or move a pure helper to lib/.",
};

// SDK confinement (Hard Rule #2): each agent SDK is importable only inside its
// own runtime adapter directory. Flat-config rule entries REPLACE (not merge),
// so every block below that configures `no-restricted-imports` must restate
// the bans it keeps — the ban objects are defined once here to stay in sync.
const CLAUDE_SDK_BAN = {
  group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
  message:
    'Claude Agent SDK imports are confined to services/runtimes/claude-code/. Import from the AgentRuntime interface instead.',
};
const DOE_SDK_BAN = {
  group: ['@dorkos/doe', '@dorkos/doe/*', '@earendil-works/pi-*', '@mariozechner/pi-*'],
  message: 'Doe and Pi imports are confined to services/runtimes/doe/. Use AgentRuntime elsewhere.',
};
const CODEX_SDK_BAN = {
  group: ['@openai/codex-sdk', '@openai/codex-sdk/*'],
  message:
    'Codex SDK imports are confined to services/runtimes/codex/. Import from the AgentRuntime interface instead.',
};
const OPENCODE_SDK_BAN = {
  group: ['@opencode-ai/sdk', '@opencode-ai/sdk/*'],
  message:
    'OpenCode SDK imports are confined to services/runtimes/opencode/. Import from the AgentRuntime interface instead.',
};
// node-pty is a native addon spawning arbitrary shells — confined to
// services/terminal/ (the embedded workbench terminal, ADR 260708-185521),
// mirroring the SDK-confinement posture above so PTY spawning has exactly one
// owner.
const NODE_PTY_BAN = {
  group: ['node-pty', 'node-pty/*'],
  message:
    'node-pty imports are confined to services/terminal/. Spawn PTYs through the terminal service, not directly.',
};
// OpenTelemetry is confined to services/observability/ (DOR-294), mirroring the
// SDK-confinement posture: the rest of the server instruments through the
// observability helpers (withSpan, startSpan, traceRuntime, traceRelay), so the
// tracing wiring has exactly one owner and stays trivially off-by-default.
const OTEL_BAN = {
  group: ['@opentelemetry/*'],
  message:
    'OpenTelemetry imports are confined to services/observability/. Instrument through the observability helpers instead.',
};
// Express left the server in DOR-2818 (ADR 261009-192542): every route is Hono
// (`http/hono-api.ts`). It runs in exactly one place, the extension host, where
// an extension's `register(router, ctx)` still fills an Express router and the
// bridge serves it (`services/extensions/http/express-bridge.ts`). Tests may
// still stand an Express app up as a fake upstream server, so the ban leaves
// them alone (see `TEST_CONFINED`).
const EXPRESS_BAN = {
  group: ['express', 'express/*'],
  message:
    'Express runs only behind the extension bridge (services/extensions/http/express-bridge.ts). Routes are Hono: mount a group in http/hono-api.ts.',
};
/** The extension-host files that hand an extension its Express router, and nothing else. */
const EXPRESS_HOSTS = [
  'src/services/extensions/http/express-bridge.ts',
  'src/services/extensions/extension-server-lifecycle.ts',
  'src/services/extensions/server-bundle/load-in-process.ts',
  'src/services/extensions/inbox/extension-inbox-context.ts',
  'src/services/extensions/isolation/child/**/*.ts',
  'src/services/extensions/__fixtures__/**/*.ts',
];

// Server tests must use the facade that accepts only an already-listening
// Server or an explicit URL. Direct Supertest imports can silently reintroduce
// the per-request listen(0)/close cycle this test boundary removes.
const SUPERTEST_BAN = {
  regex: '^supertest(?:/.*)?$',
  message:
    'Import request and its types from @dorkos/test-utils/supertest so tests can target an already-listening Server.',
};

// gray-matter `eval`s any frontmatter block that opens with `---js`, so reading
// a package's markdown with it let the package run code in the server
// (DOR-2308), and its comment-stripping regular expression is quadratic
// (DOR-2311). Frontmatter is read by `@dorkos/skills/frontmatter`, which does
// not use gray-matter at all. No directory owns it, so no `confineDirectory`
// call below filters it back out: it is banned everywhere here, tests
// included. scripts/__tests__/gray-matter-import-boundary.test.ts holds the
// same line across the whole repo.
const GRAY_MATTER_BAN = {
  group: ['gray-matter', 'gray-matter/*'],
  message:
    'gray-matter runs `---js` frontmatter as code. Use parseFrontmatter/stringifyFrontmatter from @dorkos/skills/frontmatter.',
};

// Services never import a route (DOR-4922): a route calls a service, never the
// reverse. A service that needs a route's function declares the function type it
// needs, and its composition root passes the route's function in. The pattern sees the specifier, not the resolved
// path, so it refuses a climb of two or more `../` into a folder named `routes`:
// from `services/<domain>/` that is the top-level `src/routes/`. The space
// server's own `services/spaces/routes/` is reached by one `../`, and that tree
// is not checked at all (see `SERVICES_NO_ROUTES_EXEMPT`). Middleware is not
// covered yet. Tests are exempt: they mount routes to drive a service.
const ROUTES_BAN = {
  regex: '^(?:\\.\\./){2,}routes(?:/|$)',
  message:
    "A service never imports a route (DOR-4922). Declare the function type it needs and have its composition root pass the route's function in.",
};
/**
 * Service files the routes ban does not reach.
 *
 * - `services/spaces/**`: frozen until the Community Space opens (AGENTS.md,
 *   "Where the system is going", rule 4), and it imports its own `routes/`
 *   folder, which is part of the space server.
 * - `heartbeats/heartbeats-wiring.ts`: its one route import, a type from
 *   `routes/heartbeats.ts`, goes with that file when the Heartbeat page moves
 *   onto the capability mount (DOR-4978). Remove this entry then.
 */
const SERVICES_NO_ROUTES_EXEMPT = [
  'src/services/spaces/**',
  'src/services/heartbeats/heartbeats-wiring.ts',
];

// conf picks which migrations run by `projectVersion`, so it is `SERVER_VERSION` from
// `lib/version.ts`, never a string literal (`contributing/configuration.md`, Anti-patterns). The
// selector reaches any `projectVersion` property, not only one written inside `new Conf(...)`,
// because the config manager builds the options in a `confOptions` object first. Tests are exempt:
// a migration test states the version it upgrades to.
const PROJECT_VERSION_LITERAL = {
  selector:
    "Property:matches([key.name='projectVersion'], [key.value='projectVersion'])[value.type=/^(Literal|TemplateLiteral)$/]",
  message:
    "conf's projectVersion is SERVER_VERSION from lib/version.ts, never a literal: it picks which migrations run. See contributing/configuration.md.",
};
// The chain parses the body before the route runs (`@dorkos/http-kit` request-body), so a route
// reads it with `readJsonBody(c)`; `c.req.json()` finds the stream spent (`.claude/rules/api.md`).
// Routes only: the sign-in handlers in `http/` mount ahead of the parser and read the raw body.
const RAW_BODY_READ = {
  selector:
    "CallExpression[callee.property.name='json'][callee.object.type='MemberExpression'][callee.object.property.name='req']",
  message:
    'Read the body with readJsonBody(c) from @dorkos/http-kit: the chain has already parsed it. See .claude/rules/api.md.',
};
/** Server test files, which the source-only syntax bans skip. */
const SERVER_TESTS = ['src/**/__tests__/**', 'src/**/*.{test,spec}.{ts,tsx}'];

// Every dependency confined to exactly one directory. DERIVED from, rather
// than restated alongside, both the global ban list and every per-directory
// one below: each directory owns exactly one entry and bans the rest via
// `ALL_CONFINED.filter((b) => b !== OWN_BAN)`, so a fifth ban added here
// reaches every confinement automatically instead of depending on someone
// updating N call sites by hand. This is the fix for DOR-689 (node-pty had
// silently stopped being banned in three of five directories because
// restating the list is exactly the kind of thing that drifts).
const ALL_CONFINED = [
  CLAUDE_SDK_BAN,
  DOE_SDK_BAN,
  CODEX_SDK_BAN,
  OPENCODE_SDK_BAN,
  NODE_PTY_BAN,
  OTEL_BAN,
  GRAY_MATTER_BAN,
  EXPRESS_BAN,
];
/** The directories that own one confined dependency: see `confineDirectory` below. */
const OWNER_DIRS = [
  'src/services/runtimes/claude-code/**',
  'src/services/runtimes/codex/**',
  'src/services/runtimes/opencode/**',
  'src/services/runtimes/doe/**',
  'src/services/terminal/**',
  'src/services/observability/**',
];
/** What stays banned in tests: everything but Express (see `EXPRESS_BAN`). */
const TEST_CONFINED = ALL_CONFINED.filter((ban) => ban !== EXPRESS_BAN);
// os.homedir() ban (Hard Rule #3), half one. `no-restricted-imports` sees the
// IMPORT: `import { homedir } from 'os'` and `import * as os from 'os'`. It is
// blind to `import os from 'os'` — which is the spelling this server actually
// uses — so it is only half the guard. HOMEDIR_MEMBER_BAN below is the other.
const HOMEDIR_BANS = [
  {
    name: 'os',
    importNames: ['homedir'],
    message: 'Use the resolved dorkHome parameter. See .claude/rules/dork-home.md',
  },
  {
    name: 'node:os',
    importNames: ['homedir'],
    message: 'Use the resolved dorkHome parameter. See .claude/rules/dork-home.md',
  },
];
// os.homedir() ban, half two: the CALL, `os.homedir()`. Matching on the property
// alone (no `object`) makes the ban independent of what the import is named, so
// `nodeOs.homedir()`, `require('os').homedir()` and the `os.userInfo().homedir`
// back door are caught alongside the ordinary spelling.
//
// The cost of matching that broadly, stated so the next person reaches for an
// inline disable instead of deleting the rule: it fires on ANY `.homedir`
// member access, whatever the object. `cfg.homedir`, `this.homedir`,
// `opts?.homedir`, a `homedir` field on parsed JSON — all would be reported even
// though none of them calls Node's `os`. Nothing in the server has such a field
// today. If one arrives legitimately, disable the rule on that line with a
// reason; do not narrow the matcher to `object: 'os'`, which is the hole this
// guard was written to close.
//
// This is `no-restricted-properties` rather than a second `no-restricted-syntax`
// selector because flat config REPLACES a rule's options instead of merging
// them: a `no-restricted-syntax` entry here would silently drop the base
// config's `process.env` selector for every server file, and a rule carries one
// severity — so it would either demote this ban to `warn` or promote every
// existing `process.env` warning to a build-breaking error. `no-restricted-
// properties` is set nowhere else in the monorepo, so it composes instead.
const HOMEDIR_MEMBER_BAN = {
  property: 'homedir',
  message:
    "The home directory is not DorkOS's data directory — DORK_HOME moves the latter and leaves the former alone. Use the resolved dorkHome parameter. See .claude/rules/dork-home.md",
};

/**
 * Config blocks for a directory that owns one dependency: everything in
 * `patterns` stays banned inside it, and the homedir import ban applies to its
 * source but not its tests.
 *
 * Returns a PAIR of blocks. The second exists because rule options replace
 * rather than merge: a lone block with `ignores: __tests__` would leave that
 * directory's tests with no `no-restricted-imports` at all, since the
 * server-wide block ignores `__tests__` too. Tests get the same `patterns`, so
 * the SDK confinement (Hard Rule #2) holds there, without the homedir `paths`
 * they are carved out from.
 *
 * Every confined directory is under `services/`, so the source half carries the
 * routes ban (`ROUTES_BAN`) too; the test half does not, like every test.
 *
 * Both test spellings, so the carve-out `.claude/rules/dork-home.md` states
 * without qualification is true in these directories too — a `*.test.ts` beside
 * its source must not mean a different rule from one under `__tests__/`.
 *
 * @param dir - Directory prefix, relative to the package root
 * @param patterns - Import-pattern bans that apply inside `dir`
 * @returns Two flat-config blocks: one for the source, one for the tests
 */
function confineDirectory(dir, patterns) {
  return [
    {
      files: [`${dir}/**/*.ts`],
      ignores: [`${dir}/**/__tests__/**`, `${dir}/**/*.test.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [...patterns, ROUTES_BAN], paths: HOMEDIR_BANS },
        ],
      },
    },
    {
      files: [`${dir}/**/__tests__/**/*.ts`, `${dir}/**/*.test.ts`],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [...patterns.filter((ban) => ban !== EXPRESS_BAN), SUPERTEST_BAN] },
        ],
      },
    },
  ];
}

export default defineConfig([
  {
    // Bundled core-extension SOURCE is compiled at runtime by esbuild (like user
    // extensions, which are never linted), may contain JSX in .ts files, and is
    // not part of the server's own code — exclude it from the server lint pass.
    ignores: ['dist/**', 'dist-server/**', '.turbo/**', '.temp/**', 'src/core-extensions/**'],
  },

  // Tests keep every dependency-confinement ban and additionally prohibit
  // direct Supertest runtime or type imports. Later owner-directory blocks
  // replace this rule deliberately so their own SDK remains available; the
  // confineDirectory test half re-adds SUPERTEST_BAN alongside the remaining
  // confinement patterns.
  {
    files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...TEST_CONFINED, SUPERTEST_BAN],
        },
      ],
    },
  },
  ...nodeConfig,

  // Generated OpenAPI registry — exempt from max-lines
  {
    files: ['src/services/core/openapi-registry.ts'],
    rules: { 'max-lines': 'off' },
  },

  // process.env carve-outs (server-specific).
  //
  // `**/*.config.ts` was here until DOR-1785; the shared preset now carves out
  // every build/tool config file repo-wide, so this list holds only the
  // server's own exemptions.
  {
    files: [
      '**/env.ts',
      '**/__tests__/**',
      '**/*.test.ts',
      'src/lib/dork-home.ts',
      'src/lib/logger.ts',
      // `routes/tunnel.ts` was here until DOR-1738. It read NGROK_AUTHTOKEN,
      // NODE_ENV, TUNNEL_PORT, DORKOS_PORT and VITE_PORT straight off
      // process.env; it now reads the validated `env` snapshot, and the one
      // remaining VITE_PORT read moved to `lib/trusted-origins.ts`, which owns
      // the only spelling of that variable and carries its own inline disable.
      // Do not add it back without a reason of the kind the rows below give.
      //
      // CLAUDE_CONFIG_DIR is the Claude Agent SDK's own env var (not a DorkOS
      // config value env.ts should model), read here to mirror the SDK
      // subprocess's own config-dir resolution 1:1 (DOR-250).
      'src/services/runtimes/claude-code/claude-config-dir.ts',
      // CODEX_HOME is the Codex CLI's own env var, read here for the same
      // reason and in the same shape: the search index reads rollout files the
      // CLI wrote, so it must resolve the identical directory the CLI does.
      'src/services/runtimes/codex/codex-home.ts',
      // XDG_DATA_HOME and OPENCODE_DB are the OpenCode CLI's own env vars (not
      // DorkOS config values env.ts should model), read here to mirror
      // OpenCode's own data-directory resolution 1:1 so the search snapshot
      // reads the store OpenCode actually writes. Same rationale as
      // claude-config-dir.ts above.
      'src/services/runtimes/opencode/opencode-data-dir.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // SDK confinement + node-pty confinement + os.homedir() ban (combined to avoid overwrite)
  {
    files: ['src/**/*.ts'],
    ignores: [
      ...OWNER_DIRS,
      'src/lib/dork-home.ts',
      ...EXPRESS_HOSTS,
      'src/**/__tests__/**',
      'src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ALL_CONFINED,
          paths: HOMEDIR_BANS,
        },
      ],
    },
  },

  // The same bans for services, plus the routes ban (`ROUTES_BAN`). The blocks
  // after this one that reach a service file (the Express hosts, the
  // agents-user-home carve-out and every `confineDirectory` source half) restate
  // it, because rule options replace rather than merge.
  {
    files: ['src/services/**/*.ts'],
    ignores: [
      ...OWNER_DIRS,
      ...EXPRESS_HOSTS,
      ...SERVICES_NO_ROUTES_EXEMPT,
      'src/**/__tests__/**',
      'src/**/*.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...ALL_CONFINED, ROUTES_BAN], paths: HOMEDIR_BANS },
      ],
    },
  },

  // The extension host's Express files: every other confinement still holds.
  {
    files: EXPRESS_HOSTS,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...ALL_CONFINED.filter((ban) => ban !== EXPRESS_BAN), ROUTES_BAN],
          paths: HOMEDIR_BANS,
        },
      ],
    },
  },

  // Routes never import the database, fs or a concrete runtime (DOR-4923); the two shrink-only
  // lists and the reasons are in `eslint-rules/routes-imports.js`.
  ...routesImportBlocks(ALL_CONFINED, HOMEDIR_BANS),

  // os.homedir() call ban — one block for the whole server, because unlike the
  // import bans it has no per-directory exceptions, only per-file ones. The
  // carve-outs listed here are the complete set, and they are also written down
  // where the rule is documented (.claude/rules/dork-home.md, AGENTS.md Hard
  // Rule #3) so nobody has to read the ESLint config to learn what is exempt.
  // `lib/boundary.ts` is a carve-out too, and is deliberately NOT listed here:
  // its two legitimate calls carry inline disables instead, so a future homedir
  // call anywhere else in that file is still caught.
  {
    files: ['src/**/*.ts'],
    ignores: [
      // Resolves the data directory; the one place production may fall back to ~.
      'src/lib/dork-home.ts',
      // Mirrors the Claude Agent SDK subprocess's own ~/.claude resolution 1:1.
      'src/services/runtimes/claude-code/claude-config-dir.ts',
      // Mirrors the Codex CLI's own $CODEX_HOME ?? ~/.codex resolution 1:1, so
      // the search index reads the rollout files that CLI actually wrote.
      'src/services/runtimes/codex/codex-home.ts',
      // Mirrors the OpenCode CLI's own ~/.local/share/opencode resolution 1:1.
      'src/services/runtimes/opencode/opencode-data-dir.ts',
      // Mirrors the $HOME/.agents/skills resolution FIVE vendors document as a
      // user-scope skills read path (Codex, OpenCode, Cursor, Gemini CLI,
      // Copilot — see packages/harness/src/vendor-facts/index.ts). Same shape as
      // the three rows above: it resolves another program's directory, never
      // DorkOS's own. Unlike them it is carved out of BOTH halves of the ban —
      // see the dedicated no-restricted-imports block further down for why.
      'src/services/harness/agents-user-home.ts',
      // Tests assert the fallback behavior and stage fixtures under a fake HOME.
      // Both patterns, matching the process.env carve-out block above: every
      // server test lives under __tests__/ today, and a lone `*.test.ts` beside
      // its source should not mean a different rule.
      'src/**/__tests__/**',
      'src/**/*.test.ts',
    ],
    rules: { 'no-restricted-properties': ['error', HOMEDIR_MEMBER_BAN] },
  },

  // The IMPORT half of the same carve-out, for the same one file.
  //
  // The other three file-level carve-outs are exempt from the CALL ban only:
  // the import ban still reaches them, so each has to keep spelling its import
  // `import os from 'os'` for ever, and `.claude/rules/dork-home.md` records
  // that constraint three times over. That is a wart, not a policy — the file is
  // a declared carve-out whose whole job is to call `homedir`, and which
  // spelling it uses to get there decides nothing. So this one is carved out of
  // both halves, and `scripts/test-homedir-guard.sh` pins both spellings silent
  // here and both spellings refused in a sibling.
  //
  // A block of its own rather than an `ignores` entry on the server-wide block
  // above, because rule options REPLACE rather than merge: ignoring the file
  // there would drop every SDK confinement (Hard Rule 2) for it as well, which
  // is exactly the shape that let `@openai/codex-sdk` into claude-code/__tests__
  // during DOR-668. Handing `ALL_CONFINED` straight back keeps those bans and
  // drops only the homedir `paths`.
  {
    files: ['src/services/harness/agents-user-home.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...ALL_CONFINED, ROUTES_BAN] }] },
  },

  // Every directory that owns one dependency: everything else in
  // `ALL_CONFINED` stays banned there, and the homedir IMPORT ban applies to
  // its source.
  //
  // Two blocks per directory, on purpose. Block 1 above already ignores
  // `src/**` + `__tests__`, so these per-directory blocks are the ONLY thing
  // supplying `no-restricted-imports` to a test directory — which means a single
  // block with `ignores: __tests__` does not "exempt tests from the homedir
  // ban", it drops that directory's SDK bans as well. (Caught in review on
  // DOR-668, after exactly that shape let `@openai/codex-sdk` into
  // claude-code/__tests__.) The second block hands the patterns straight back,
  // minus the homedir paths tests are carved out from.
  //
  // Built from one helper, filtering the single `ALL_CONFINED` source rather
  // than restating each directory's ban list by hand — restating by hand is
  // what drifted (DOR-689: node-pty silently stopped being banned in three of
  // these five directories, because nobody updates every call site when a
  // fifth ban is added). `!== OWN_BAN` is safe because every ban is a distinct
  // object identity, never reconstructed, so this can never accidentally
  // filter out a different directory's ban with the same shape.
  ...confineDirectory(
    'src/services/terminal',
    ALL_CONFINED.filter((ban) => ban !== NODE_PTY_BAN)
  ),
  ...confineDirectory(
    'src/services/observability',
    ALL_CONFINED.filter((ban) => ban !== OTEL_BAN)
  ),
  ...confineDirectory(
    'src/services/runtimes/claude-code',
    ALL_CONFINED.filter((ban) => ban !== CLAUDE_SDK_BAN)
  ),
  ...confineDirectory(
    'src/services/runtimes/codex',
    ALL_CONFINED.filter((ban) => ban !== CODEX_SDK_BAN)
  ),
  ...confineDirectory(
    'src/services/runtimes/opencode',
    ALL_CONFINED.filter((ban) => ban !== OPENCODE_SDK_BAN)
  ),

  ...confineDirectory(
    'src/services/runtimes/doe',
    ALL_CONFINED.filter((ban) => ban !== DOE_SDK_BAN)
  ),

  // The space server ships alone, in its own image (server-merge step 7): its code imports only
  // itself and its image's packages, and nothing else here imports it. Tests are not checked.
  {
    files: ['src/services/spaces/**/*.{ts,tsx}'],
    ignores: ['src/services/spaces/**/__tests__/**', 'src/services/spaces/**/*.test.{ts,tsx}'],
    plugins: { spaces },
    rules: { 'spaces/stay-inside': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/services/spaces/**', 'src/**/__tests__/**', 'src/**/*.test.{ts,tsx}'],
    plugins: { spaces },
    rules: { 'spaces/no-reach-in': 'error' },
  },
  // The work graph is space data: turn code reaches it only through hooks or events, so its
  // move to the space store (DOR-5139) is a store move. Tests are checked too.
  {
    files: ['src/services/runtimes/**/*.{ts,tsx}', 'src/services/session/**/*.{ts,tsx}'],
    plugins: { 'work-graph': workGraph },
    rules: { 'work-graph/stay-out': 'error' },
  },
  // The runtimes build on session, never the reverse (DOR-4928): a shared piece lives in session
  // or core, and an adapter's own fact reaches session through a port. Tests are not checked.
  {
    files: ['src/services/session/**/*.{ts,tsx}'],
    ignores: ['src/services/session/**/__tests__/**', 'src/services/session/**/*.test.{ts,tsx}'],
    plugins: { 'session-runtimes': sessionRuntimes },
    rules: { 'session-runtimes/no-runtimes': 'error' },
  },

  // The middleware ban (`MIDDLEWARE_BAN`) for every service. Not `services/spaces/**`: it is
  // frozen until the Community Space opens (AGENTS.md, "Where the system is going", rule 4).
  // Tests are exempt: they mount a chain step to drive a service.
  {
    files: ['src/services/**/*.{ts,tsx}'],
    ignores: ['src/services/spaces/**', 'src/**/__tests__/**', 'src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [MIDDLEWARE_BAN] }],
    },
  },

  // Every error answer is a problem document (ADR 261123-170831): no hand-built `{ error }`
  // body in the HTTP layer. Tests are not checked: they assert what old shapes looked like.
  {
    files: ['src/routes/**/*.ts', 'src/http/**/*.ts', 'src/middleware/**/*.ts'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.ts'],
    plugins: { 'problem-only': problemOnly },
    rules: { 'problem-only/no-error-body': 'error' },
  },

  // The turn port's ratchet (spec `turns-survive-restarts` §3.4): the space side reaches turn code
  // only through the turn port, and the imports that do not yet may only go
  // (`turn-port-boundary.baseline.json`). Tests are not checked.
  {
    files: ['src/services/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**', 'src/**/*.test.{ts,tsx}'],
    plugins: { 'turn-port': turnPort },
    rules: { 'turn-port/boundary': 'error' },
  },

  // The computer wall (spec `computer-side-starts-alone` §4): every file under services/ is on a
  // side in `sides.json`, and a computer-side file adds no import of space-side or front-door code
  // and names no space table, beyond its entry in `computer-wall.baseline.json`. Tests and
  // fixtures are not checked.
  {
    files: ['src/services/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**', 'src/**/__fixtures__/**', 'src/**/*.{test,spec}.{ts,tsx}'],
    plugins: { 'computer-wall': computerWall },
    rules: { 'computer-wall/wall': 'error' },
  },

  // The services import boundary (DOR-4924): one domain under services/ (each folder under core/ is
  // its own) imports another only along a pair in `import-boundary.baseline.json`. Type-only
  // imports are allowed; tests and fixtures are not checked.
  {
    files: ['src/services/**/*.{ts,tsx}'],
    ignores: ['src/**/__tests__/**', 'src/**/__fixtures__/**', 'src/**/*.{test,spec}.{ts,tsx}'],
    plugins: { 'import-boundary': importBoundary },
    rules: { 'import-boundary/boundary': 'error' },
  },

  // Hard syntax bans (DOR-4938), on `dorkos/restricted-syntax`: the core `no-restricted-syntax`
  // under a second name, so these fail lint while the shared `process.env` selector stays a
  // warning (see `dorkosPlugin` in `@dorkos/eslint-config/base`). Options replace rather than
  // merge, so the routes block restates `PROJECT_VERSION_LITERAL`. Tests get the shared test
  // preset's selectors instead, from `testConfig` below.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: SERVER_TESTS,
    rules: { 'dorkos/restricted-syntax': ['error', PROJECT_VERSION_LITERAL] },
  },
  {
    files: ['src/routes/**/*.{ts,tsx}'],
    ignores: SERVER_TESTS,
    rules: { 'dorkos/restricted-syntax': ['error', PROJECT_VERSION_LITERAL, RAW_BODY_READ] },
  },

  ...testConfig,
]);
