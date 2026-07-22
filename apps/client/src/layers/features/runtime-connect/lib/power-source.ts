/**
 * Plain-language names for OpenCode power sources (spec §9 — the "Change" flow).
 *
 * Maps a persisted provider id (`runtimes.opencode.provider`) to a human label
 * for the "Currently: …" line shown when the picker is reopened to switch
 * sources. Kept pure so it is easy to unit-test.
 *
 * @module features/runtime-connect/lib/power-source
 */

/** Plain-language provider names for the bring-your-own-key label. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** Human name for a provider id — a known name, or the raw id the user chose. */
function providerDisplayName(id: string): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? id;
}

/**
 * The plain-language name of a connected OpenCode power source, for the
 * "Currently: …" label. Cloud (`openrouter`) and local (`ollama`) get their own
 * wording; every other provider is a bring-your-own-key connection.
 *
 * @param providerId - The persisted provider id (`runtimes.opencode.provider`).
 */
export function describePowerSource(providerId: string): string {
  switch (providerId) {
    case 'ollama':
      return 'On your computer (Ollama)';
    case 'openrouter':
      return 'Cloud via OpenRouter';
    default:
      return `Your own API key (${providerDisplayName(providerId)})`;
  }
}
