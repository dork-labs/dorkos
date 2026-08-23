/**
 * Changing a session's settings in the EMBEDDED cockpit (Obsidian).
 *
 * `DirectTransport` calls the runtime in-process and never touches the HTTP
 * route, so it has no status code to carry the one fact a `202` carries on the
 * wire: a stricter permission mode is saved, and the reply already running kept
 * the looser one it started under (DOR-1435). Here the field IS the whole
 * signal, and if this seam dropped it the Obsidian half of that fix would be
 * silent — which is the bug it exists to fix.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import type { SessionUpdateResult } from '@dorkos/shared/agent-runtime';
import { createDirectSessionMethods } from '../session-methods';
import type { DirectTransportServices } from '../services';

const SESSION_ID = 'session-in-the-vault';

const STORED: Session = {
  id: SESSION_ID,
  title: 'Reviewing a migration',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  permissionMode: 'default',
  runtime: 'claude-code',
};

/**
 * The two service seams this path touches, with the runtime's answer scripted.
 *
 * @param answer - What the embedded runtime reports the update settled as.
 */
function methodsAnswering(answer: SessionUpdateResult) {
  const updateSession = vi.fn().mockResolvedValue(answer);
  const services = {
    vaultRoot: '/vault',
    runtime: { updateSession },
    transcriptReader: { getSession: vi.fn().mockResolvedValue(STORED) },
  } as unknown as DirectTransportServices;
  return { methods: createDirectSessionMethods(services, () => 'client-1'), updateSession };
}

describe('DirectTransport.updateSession', () => {
  it('carries "not in force yet" back to the embedded cockpit', async () => {
    const { methods } = methodsAnswering({
      updated: true,
      permissionModePendingUntilNextTurn: true,
    });

    const result = await methods.updateSession(SESSION_ID, { permissionMode: 'default' });

    // The session it read back, plus the one thing the session cannot say.
    expect(result).toEqual({ ...STORED, permissionModePendingUntilNextTurn: true });
  });

  it('answers with the plain session when the change did reach the running reply', async () => {
    const { methods } = methodsAnswering({ updated: true });

    const result = await methods.updateSession(SESSION_ID, { permissionMode: 'default' });

    expect(result).toEqual(STORED);
    expect(result).not.toHaveProperty('permissionModePendingUntilNextTurn');
  });

  it('throws when the embedded runtime has no such session', async () => {
    const { methods } = methodsAnswering({ updated: false });

    await expect(methods.updateSession(SESSION_ID, { permissionMode: 'default' })).rejects.toThrow(
      /Session not found/
    );
  });

  it('passes the requested settings straight through to the runtime', async () => {
    const { methods, updateSession } = methodsAnswering({ updated: true });

    await methods.updateSession(SESSION_ID, { permissionMode: 'plan', model: 'opus' });

    expect(updateSession).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ permissionMode: 'plan', model: 'opus' })
    );
  });
});
