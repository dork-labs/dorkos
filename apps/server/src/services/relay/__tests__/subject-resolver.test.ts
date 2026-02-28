import { describe, it, expect, vi } from 'vitest';
import { resolveSubjectLabel, type SubjectLabel } from '../subject-resolver.js';

describe('resolveSubjectLabel', () => {
  it('resolves relay.human.console.* to "You"', async () => {
    const result = await resolveSubjectLabel('relay.human.console.abc-123', {});
    expect(result).toEqual({ label: 'You', raw: 'relay.human.console.abc-123' });
  });

  it('resolves relay.system.console to "System Console"', async () => {
    const result = await resolveSubjectLabel('relay.system.console', {});
    expect(result).toEqual({ label: 'System Console', raw: 'relay.system.console' });
  });

  it('resolves relay.system.pulse.* to "Pulse Scheduler"', async () => {
    const result = await resolveSubjectLabel('relay.system.pulse.sched-1', {});
    expect(result).toEqual({ label: 'Pulse Scheduler', raw: 'relay.system.pulse.sched-1' });
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
});
