import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const VERSION = readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8').trim();

/** Read a release version; a missing patch means zero. */
function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

/** Compare release versions numerically, including patch releases. */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Build the error and warning rules from the same schedule parser. */
function createRule(earlyWarning) {
  return {
    meta: {
      type: 'problem',
      docs: { description: 'Require deprecation versions and reject overdue removals.' },
      schema: [
        {
          type: 'object',
          properties: { version: { type: 'string' } },
          additionalProperties: false,
        },
      ],
      messages: {
        missingSchedule: 'Use "@deprecated since 0.x, remove in 0.y" with a later removal version.',
        approaching:
          'This deprecated API becomes an error in {{removal}} (VERSION {{version}}). Remove it before then.',
        expired:
          'Removal version {{removal}} has been reached (VERSION {{version}}). Remove this deprecated API.',
      },
    },
    create(context) {
      const version = context.options[0]?.version ?? VERSION;
      const current = parseVersion(version);
      if (!current) throw new Error(`Invalid deprecation-policy VERSION: ${version}`);
      const source = context.sourceCode;

      return {
        Program() {
          for (const comment of source.getAllComments()) {
            // Only JSDoc tags, never example strings, prose mentions or ordinary comments.
            if (comment.type !== 'Block' || !comment.value.startsWith('*')) continue;
            const tags = comment.value.matchAll(
              /(?:^|\r?\n)[ \t]*\*?[ \t]*@deprecated\b([^\r\n]*)/g
            );
            for (const tag of tags) {
              const offset = comment.range[0] + 2 + tag.index + tag[0].indexOf('@deprecated');
              const loc = {
                start: source.getLocFromIndex(offset),
                end: source.getLocFromIndex(offset + '@deprecated'.length),
              };
              const schedule =
                /^\s*since (\d+\.\d+(?:\.\d+)?), remove in (\d+\.\d+(?:\.\d+)?)(?=\s|$|[,;)]|\.(?:\s|$))/.exec(
                  tag[1]
                );
              const since = schedule && parseVersion(schedule[1]);
              const removal = schedule && parseVersion(schedule[2]);
              if (!since || !removal || compareVersions(removal, since) <= 0) {
                if (!earlyWarning) context.report({ loc, messageId: 'missingSchedule' });
              } else if (!earlyWarning && compareVersions(current, removal) >= 0) {
                context.report({
                  loc,
                  messageId: 'expired',
                  data: { removal: schedule[2], version },
                });
              } else if (
                earlyWarning &&
                compareVersions(current, removal) < 0 &&
                compareVersions(current, [removal[0], Math.max(0, removal[1] - 2), 0]) >= 0
              ) {
                context.report({
                  loc,
                  messageId: 'approaching',
                  data: { removal: schedule[2], version },
                });
              }
            }
          }
        },
      };
    },
  };
}

// ESLint sets severity per rule, so the warning uses the same parser at warn level.
/**
 * Warn during the two minor versions before a deprecation deadline.
 * Windows stay within the removal major: N.0 has none, and N.1 warns only in N.0.x.
 */
export const deprecatedRemovalSoon = createRule(true);
export default createRule(false);
