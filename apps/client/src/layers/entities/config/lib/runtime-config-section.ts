/**
 * Which `runtimes.*` config section holds one runtime's settings.
 *
 * Runtime type ids are kebab-case on the wire and camelCase in config, and the
 * two lists are allowed to differ — `test-mode` is a real runtime with no
 * section at all. Mirrors `CONFIG_SECTION_BY_RUNTIME` on the server
 * (`services/session/resolve-session-defaults.ts`), which is the authority.
 *
 * One copy on the client, not one per screen: Settings and the status line both
 * write per-runtime defaults now, and two spellings of this map is how one of
 * them ends up writing a leaf nothing reads.
 *
 * @module entities/config/lib/runtime-config-section
 */

/** The config key each runtime's settings live under. */
const CONFIG_SECTION_BY_RUNTIME: Readonly<Record<string, 'claudeCode' | 'codex' | 'opencode'>> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * The config section for a runtime, or `undefined` for one that has none.
 *
 * Absence is an answer, not an error: a runtime with no section simply has no
 * per-runtime setting to write, and a caller should fall back to the global one
 * rather than inventing a key.
 *
 * @param runtime - Runtime type id, e.g. `'claude-code'`.
 */
export function configSectionForRuntime(
  runtime: string | null | undefined
): 'claudeCode' | 'codex' | 'opencode' | undefined {
  return runtime ? CONFIG_SECTION_BY_RUNTIME[runtime] : undefined;
}
