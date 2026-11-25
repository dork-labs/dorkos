import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TASK_SUBJECT_LABEL } from '@dorkos/shared/relay-schemas';
import { resolveSubjectLabel, resolveSubjectLabels } from '../subject-resolver.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home, so the mocked lookups below
// decide who is an agent (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

describe('resolveSubjectLabel', () => {
  it.each([
    ['relay.human.console.abc-123', 'You'],
    ['relay.system.console', 'System Console'],
    // Shared with the client's resolver so the two never drift (DOR-1490).
    ['relay.system.tasks.sched-1', TASK_SUBJECT_LABEL],
    ['some.unknown.subject', 'some.unknown.subject'],
  ])('labels %s as %s', async (subject, label) => {
    expect(await resolveSubjectLabel(subject, {})).toEqual({ label, raw: subject });
  });

  it.each([
    'relay.agent.abc-123-def',
    'relay.agent.claude-code.abc-123-def',
    'relay.inbox.abc-123-def',
  ])('names %s after its agent, or falls back to its short session id', async (subject) => {
    const getSession = vi.fn().mockResolvedValue({ cwd: '/path/to/project' });
    const named = await resolveSubjectLabel(subject, {
      getSession,
      readManifest: vi.fn().mockResolvedValue({ name: 'Obsidian Repo' }),
    });
    expect(named.label).toBe('Obsidian Repo');
    // The runtime segment is stripped before the session lookup.
    expect(getSession).toHaveBeenCalledWith('abc-123-def');
    const unnamed = await resolveSubjectLabel(subject, {
      getSession: vi.fn().mockRejectedValue(new Error('not found')),
    });
    expect(unnamed.label).toBe('Agent (abc-123)');
  });
});

it('resolveSubjectLabels deduplicates subjects and resolves all', async () => {
  const result = await resolveSubjectLabels(
    ['relay.human.console.x', 'relay.human.console.x', 'relay.system.console'],
    {}
  );
  expect(result.size).toBe(2);
  expect(result.get('relay.system.console')?.label).toBe('System Console');
});
