import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  { ignores: ['dist/**', 'dist-server/**', '.turbo/**', '.temp/**'] },
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
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // SDK confinement + os.homedir() ban (combined to avoid overwrite)
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/services/runtimes/claude-code/**',
      'src/lib/dork-home.ts',
      'src/**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk/*'],
              message:
                'Claude Agent SDK imports are confined to services/runtimes/claude-code/. Import from the AgentRuntime interface instead.',
            },
          ],
          paths: [
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
          ],
        },
      ],
    },
  },

  ...testConfig,
]);
