/**
 * Font Configuration Registry
 *
 * This is the single source of truth for all font pairings.
 * To add a new font:
 *   1. Append a new object to FONT_CONFIGS below
 *   2. That's it. The type, dropdown, loader, and validation all derive from this array.
 *
 * Each entry defines:
 *   - key: Unique identifier, stored in localStorage
 *   - displayName: Shown in the Settings dropdown
 *   - description: Subtitle in dropdown (e.g., "Inter + JetBrains Mono")
 *   - sans: CSS font-family value for UI text
 *   - mono: CSS font-family value for code blocks
 *   - googleFontsUrl: URL for the Google Fonts stylesheet (null = no external load)
 */

export interface FontConfig {
  key: string;
  displayName: string;
  description: string;
  sans: string;
  mono: string;
  googleFontsUrl: string | null;
}

export const FONT_CONFIGS = [
  {
    key: 'system',
    displayName: 'System Default',
    description: 'Native platform fonts',
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace",
    googleFontsUrl: null,
  },
  {
    key: 'inter',
    displayName: 'Inter',
    description: 'Inter + JetBrains Mono',
    sans: "'Inter', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap',
  },
  {
    key: 'geist',
    displayName: 'Geist',
    description: 'Geist + Geist Mono',
    sans: "'Geist', system-ui, sans-serif",
    mono: "'Geist Mono', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap',
  },
  {
    key: 'ibm-plex',
    displayName: 'IBM Plex',
    description: 'IBM Plex Sans + IBM Plex Mono',
    sans: "'IBM Plex Sans', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono&display=swap',
  },
  {
    key: 'roboto',
    displayName: 'Roboto',
    description: 'Roboto + Roboto Mono',
    sans: "'Roboto', system-ui, sans-serif",
    mono: "'Roboto Mono', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono&display=swap',
  },
  {
    key: 'source',
    displayName: 'Source',
    description: 'Source Sans 3 + Source Code Pro',
    sans: "'Source Sans 3', system-ui, sans-serif",
    mono: "'Source Code Pro', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600&family=Source+Code+Pro&display=swap',
  },
  {
    key: 'fira',
    displayName: 'Fira',
    description: 'Fira Sans + Fira Code',
    sans: "'Fira Sans', system-ui, sans-serif",
    mono: "'Fira Code', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600&family=Fira+Code&display=swap',
  },
  {
    key: 'space',
    displayName: 'Space',
    description: 'Space Grotesk + Space Mono',
    sans: "'Space Grotesk', system-ui, sans-serif",
    mono: "'Space Mono', ui-monospace, monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=Space+Mono&display=swap',
  },
] as const satisfies readonly FontConfig[];

/** Union type of all valid font keys — derived from the config array */
export type FontFamilyKey = (typeof FONT_CONFIGS)[number]['key'];

/** Default font key for new users / reset */
export const DEFAULT_FONT: FontFamilyKey = 'inter';

/** Look up a font config by key. Returns default font config if key is invalid. */
export function getFontConfig(key: string): FontConfig {
  return (
    FONT_CONFIGS.find((f) => f.key === key) ?? FONT_CONFIGS.find((f) => f.key === DEFAULT_FONT)!
  );
}

/** Check if a string is a valid FontFamilyKey */
export function isValidFontKey(key: string): key is FontFamilyKey {
  return FONT_CONFIGS.some((f) => f.key === key);
}
