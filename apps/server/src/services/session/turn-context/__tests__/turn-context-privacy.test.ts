/**
 * The turn-context record is private to the person (Security, Nov 8): no
 * route, agent tool, extension or feedback bundle may read it until a later
 * phase is reviewed. These checks pin who may import it, so a reader cannot
 * be added without this list changing in review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = path.resolve(__dirname, '../../../..');

/** Every file allowed to import the record, relative to `apps/server/src`. Writers only. */
const ALLOWED_IMPORTERS = new Set([
  // The installer and the hourly sweep.
  'startup/steps/core-stores.ts',
  'startup/steps/after-listen.ts',
  // Deletion with the session.
  'services/session/message-dispatcher/queue-upkeep.ts',
  // The four adapters, each at the point it hands the prompt over.
  'services/runtimes/claude-code/messaging/turn-context/turn-context-record.ts',
  'services/runtimes/codex/turn-input.ts',
  'services/runtimes/opencode/messaging/turn-input.ts',
  'services/runtimes/doe/turn-context-record.ts',
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('turn-context privacy', () => {
  it('is imported only by its writers, never by a route, tool, extension or the feedback path', () => {
    const recordDir = path.join(SERVER_SRC, 'services', 'session', 'turn-context') + path.sep;
    const importsRecord = (file: string): boolean =>
      [...fs.readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)].some((match) =>
        path.resolve(path.dirname(file), match[1]!).startsWith(recordDir)
      );
    const importers = sourceFiles(SERVER_SRC)
      .filter((file) => !file.startsWith(recordDir))
      .filter(importsRecord)
      .map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'));
    expect(importers.sort()).toEqual([...ALLOWED_IMPORTERS].sort());
  });

  it('is not named anywhere a feedback report is built', () => {
    for (const file of [
      'routes/feedback.ts',
      'services/core/feedback-reporter.ts',
      'lib/log-excerpt.ts',
      'lib/transcript-excerpt.ts',
    ]) {
      const source = fs.readFileSync(path.join(SERVER_SRC, file), 'utf8');
      expect(source, file).not.toMatch(/turn[-_]?context|turnContext|dork\.db/i);
    }
  });
});
