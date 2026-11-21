import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { describe, expect, it } from 'vitest';
import {
  extensionErrors,
  withSupervisedStatus,
} from '../isolation/recovery/extension-diagnostics.js';

function record(id: string, status: ExtensionRecordPublic['status']): ExtensionRecordPublic {
  return { id, status } as ExtensionRecordPublic;
}

describe('extension diagnostics', () => {
  it('keeps every client error and a stopped server, excluding a healthy client', () => {
    const records = [
      record('healthy', 'compiled'),
      record('stopped', 'compiled'),
      record('invalid', 'invalid'),
      record('incompatible', 'incompatible'),
      record('compile', 'compile_error'),
      record('activate', 'activate_error'),
    ];
    const serverError = {
      code: 'server_unresponsive',
      message: 'Stopped',
      occurredAt: '2026-11-21T11:00:00Z',
    };
    expect(
      extensionErrors(records, (id) => (id === 'stopped' ? { serverError } : {})).map((r) => r.id)
    ).toEqual(['stopped', 'invalid', 'incompatible', 'compile', 'activate']);
  });

  it('keeps the stopped reason in diagnostics while the card says Restarting', () => {
    const status = {
      restartingAt: '2026-11-21T11:01:00Z',
      serverError: {
        code: 'isolation_unavailable',
        message: 'Could not start',
        occurredAt: '2026-11-21T11:00:00Z',
      },
    };
    const card = withSupervisedStatus(record('stopped', 'compiled'), status);
    expect(card.serverError).toBeUndefined();
    expect(card.restartingAt).toBe(status.restartingAt);
    expect(extensionErrors([card], () => status)[0].serverError).toEqual(status.serverError);
  });
});
