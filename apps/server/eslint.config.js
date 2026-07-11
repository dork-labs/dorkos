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
      'src/routes/tunnel.ts',
      // CLAUDE_CONFIG_DIR is the Claude Agent SDK's own env var (not a DorkOS
      // config value env.ts should model), read here to mirror the SDK
      // subprocess's own config-dir resolution 1:1 (DOR-250). Same rationale
      // as tunnel.ts's NGROK_AUTHTOKEN above.
      'src/services/runtimes/claude-code/claude-config-dir.ts',
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
          patterns: [CLAUDE_SDK_BAN, CODEX_SDK_BAN, OPENCODE_SDK_BAN, NODE_PTY_BAN, OTEL_BAN],
          paths: HOMEDIR_BANS,
        },
      ],
    },
  },

  // The terminal service may import node-pty (its sole owner); every SDK stays
  // banned there, and the homedir ban still applies (new code).
  {
    files: ['src/services/terminal/**/*.ts'],
    ignores: ['src/services/terminal/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [CLAUDE_SDK_BAN, CODEX_SDK_BAN, OPENCODE_SDK_BAN, OTEL_BAN],
          paths: HOMEDIR_BANS,
        },
      ],
    },
  },

  // Each adapter directory may import its OWN SDK; every other SDK stays
  // banned there. (claude-code predates the homedir ban and keeps its
  // historical exemption; codex and opencode are new code, so the ban applies.)
  {
    files: ['src/services/runtimes/claude-code/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [CODEX_SDK_BAN, OPENCODE_SDK_BAN, OTEL_BAN] }],
    },
  },
  {
    files: ['src/services/runtimes/codex/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [CLAUDE_SDK_BAN, OPENCODE_SDK_BAN, OTEL_BAN], paths: HOMEDIR_BANS },
      ],
    },
  },
  {
    files: ['src/services/runtimes/opencode/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [CLAUDE_SDK_BAN, CODEX_SDK_BAN, OTEL_BAN], paths: HOMEDIR_BANS },
      ],
    },
  },

  ...testConfig,
]);
