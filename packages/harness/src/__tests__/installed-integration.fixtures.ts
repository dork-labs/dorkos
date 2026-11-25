/**
 * Helpers shared by the `installed-integration*.test.ts` suites, which project a
 * real installed plugin into a temp repo. Not a `*.test.ts`, so vitest never
 * collects it as a suite.
 *
 * @module __tests__/installed-integration.fixtures
 */

/**
 * A settings command with DorkOS's plugin-env prefix removed (DOR-2245), so a
 * test reads the package's own command. A user hook never carries the prefix.
 */
export function withoutEnvPrefix(command: string): string {
  return command.startsWith('export CLAUDE_PLUGIN_ROOT=')
    ? command.slice(command.indexOf('; ') + 2)
    : command;
}
