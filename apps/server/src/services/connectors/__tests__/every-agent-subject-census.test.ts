/**
 * The bare every-agent grant subject is only for reads and writes about the
 * share itself (DOR-3975). A read about ONE agent must use
 * `everyAgentGrantFor(agentId)` or `agent-grant-scope.ts`, or an agent left
 * out of the share (DOR-3961) would get it back through that read.
 *
 * Adding a file here means it never answers "what can this agent do". Say why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Files allowed to name the bare subject, each with why it is about the share. */
const SHARE_LEVEL_FILES: Record<string, string> = {
  'services/connectors/every-agent-grants.ts':
    'defines the subject, writes and revokes the share, and builds everyAgentGrantFor on it',
  'services/connectors/reconciliation-service.ts':
    'previews, applies and follows the share itself for the owner',
  'services/connectors/management-review-context.ts':
    'tells the owner what the share gives every agent before a review is decided',
  'services/connectors/resources/managed-authority-sync-service.ts':
    'syncs the share itself to hosted authority',
};

/** Ways to name the every-agent subject directly, rather than for one agent. */
const BARE_SUBJECT = [
  /\beveryAgentGrantSubject\s*\(/,
  /connectionOperationGrants\.subjectType,\s*'every_agent'/,
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('every-agent subject census', () => {
  it('names the bare every-agent subject only in files about the share itself', () => {
    const users = sourceFiles(SERVER_SRC)
      .filter((file) => {
        const text = fs.readFileSync(file, 'utf8');
        return BARE_SUBJECT.some((pattern) => pattern.test(text));
      })
      .map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'))
      .sort();

    expect(users).toEqual(Object.keys(SHARE_LEVEL_FILES).sort());
  });
});
