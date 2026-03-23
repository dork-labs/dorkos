import ansiRegex from 'ansi-regex';

/** Content type classification for tool output rendering. */
export type ContentType = 'json' | 'ansi' | 'plain';

// Use onlyFirst: true to avoid the stateful lastIndex issue with global regexes.
const ANSI_PATTERN = ansiRegex({ onlyFirst: true });

/** Classify a string as JSON, ANSI-colored, or plain text. */
export function classifyContent(content: string): ContentType {
  if (ANSI_PATTERN.test(content)) return 'ansi';
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(content);
      return 'json';
    } catch {
      // Partial or invalid JSON
    }
  }
  return 'plain';
}
