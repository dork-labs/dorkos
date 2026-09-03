import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

// SDK confinement (Hard Rule #2): each agent SDK is importable only inside its
// own runtime adapter directory. Flat-config rule entries REPLACE (not merge),
// so every block below that configures `no-restricted-imports` must restate
// the bans it keeps — the ban objects are defined once here to stay in sync.
const CLAUDE_SDK_BAN = {
  group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
  message:
    'Claude Agent SDK imports are confined to services/runtimes/claude-code/. Import from the AgentRuntime interface instead.',
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

// Every dependency confined to exactly one directory. DERIVED from, rather
// than restated alongside, both the global ban list and every per-directory
// one below: each directory owns exactly one entry and bans the rest via
// `ALL_CONFINED.filter((b) => b !== OWN_BAN)`, so a fifth ban added here
// reaches every confinement automatically instead of depending on someone
// updating N call sites by hand. This is the fix for DOR-689 (node-pty had
// silently stopped being banned in three of five directories because
// restating the list is exactly the kind of thing that drifts).
const ALL_CONFINED = [CLAUDE_SDK_BAN, CODEX_SDK_BAN, OPENCODE_SDK_BAN, NODE_PTY_BAN, OTEL_BAN];
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
      rules: { 'no-restricted-imports': ['error', { patterns, paths: HOMEDIR_BANS }] },
    },
    {
      files: [`${dir}/**/__tests__/**/*.ts`, `${dir}/**/*.test.ts`],
      rules: { 'no-restricted-imports': ['error', { patterns }] },
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
  ...nodeConfig,

  // Generated OpenAPI registry — exempt from max-lines
  {
    files: ['src/services/core/openapi-registry.ts'],
    rules: { 'max-lines': 'off' },
  },

  // process.env carve-outs (server-specific)
  {
    files: [
      '**/env.ts',
      '**/*.config.ts',
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
      'src/services/runtimes/claude-code/**',
      'src/services/runtimes/codex/**',
      'src/services/runtimes/opencode/**',
      'src/services/terminal/**',
      'src/services/observability/**',
      'src/lib/dork-home.ts',
      'src/**/__tests__/**',
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
      // Tests assert the fallback behavior and stage fixtures under a fake HOME.
      // Both patterns, matching the process.env carve-out block above: every
      // server test lives under __tests__/ today, and a lone `*.test.ts` beside
      // its source should not mean a different rule.
      'src/**/__tests__/**',
      'src/**/*.test.ts',
    ],
    rules: { 'no-restricted-properties': ['error', HOMEDIR_MEMBER_BAN] },
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

  ...testConfig,
]);
