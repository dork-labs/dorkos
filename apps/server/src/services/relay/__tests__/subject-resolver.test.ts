import { describe, it, expect, vi } from 'vitest';
import { resolveSubjectLabel, resolveSubjectLabels } from '../subject-resolver.js';

describe('resolveSubjectLabel', () => {
  it('resolves relay.human.console.* to "You"', async () => {
    const result = await resolveSubjectLabel('relay.human.console.abc-123', {});
    expect(result).toEqual({ label: 'You', raw: 'relay.human.console.abc-123' });
  });

  it('resolves relay.system.console to "System Console"', async () => {
    const result = await resolveSubjectLabel('relay.system.console', {});
    expect(result).toEqual({ label: 'System Console', raw: 'relay.system.console' });
  });

  it('resolves relay.system.tasks.* to "Tasks Scheduler"', async () => {
    const result = await resolveSubjectLabel('relay.system.tasks.sched-1', {});
    expect(result).toEqual({ label: 'Tasks Scheduler', raw: 'relay.system.tasks.sched-1' });
  });

  it('resolves relay.agent.{sessionId} to agent name when available', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path/to/project' });
    const mockReadManifest = vi.fn().mockResolvedValue({ name: 'Obsidian Repo' });
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'Obsidian Repo', raw: 'relay.agent.abc-123-def' });
  });

  it('falls back to truncated session ID when agent not found', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path' });
    const mockReadManifest = vi.fn().mockResolvedValue(null);
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'Agent (abc-123)', raw: 'relay.agent.abc-123-def' });
  });

  it('falls back gracefully when session lookup fails', async () => {
    const mockGetSession = vi.fn().mockRejectedValue(new Error('not found'));
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
    });
    expect(result).toEqual({ label: 'Agent (abc-123)', raw: 'relay.agent.abc-123-def' });
  });

  it('resolves runtime-scoped relay.agent.{runtimeType}.{sessionId} the same as legacy', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path/to/project' });
    const mockReadManifest = vi.fn().mockResolvedValue({ name: 'Obsidian Repo' });
    const result = await resolveSubjectLabel('relay.agent.claude-code.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({
      label: 'Obsidian Repo',
      raw: 'relay.agent.claude-code.abc-123-def',
    });
    // The parser strips the runtime-type segment before the session lookup.
    expect(mockGetSession).toHaveBeenCalledWith('abc-123-def');
  });

  it('resolves relay.inbox.{sessionId} — same agent name lookup as relay.agent.*', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path/to/project' });
    const mockReadManifest = vi.fn().mockResolvedValue({ name: 'InboxBot' });
    const result = await resolveSubjectLabel('relay.inbox.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'InboxBot', raw: 'relay.inbox.abc-123-def' });
  });

  it('relay.inbox.* falls back to Agent (shortId) when no manifest', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path' });
    const mockReadManifest = vi.fn().mockResolvedValue(null);
    const result = await resolveSubjectLabel('relay.inbox.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'Agent (abc-123)', raw: 'relay.inbox.abc-123-def' });
  });

  it('unknown subject passes through as-is', async () => {
    const result = await resolveSubjectLabel('some.unknown.subject', {});
    expect(result).toEqual({ label: 'some.unknown.subject', raw: 'some.unknown.subject' });
  });
});

describe('resolveSubjectLabels', () => {
  it('deduplicates subjects and resolves all', async () => {
    const subjects = ['relay.human.console.x', 'relay.human.console.x', 'relay.system.console'];
    const result = await resolveSubjectLabels(subjects, {});
    expect(result.size).toBe(2);
    expect(result.get('relay.human.console.x')?.label).toBe('You');
    expect(result.get('relay.system.console')?.label).toBe('System Console');
  });
});
