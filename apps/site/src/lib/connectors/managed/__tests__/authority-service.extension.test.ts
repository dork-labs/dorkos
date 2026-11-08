/**
 * This hosted service holds no extension grants (DOR-3980): it refuses
 * `replace_extension_grants` before it touches the database. Made-up data.
 */
import { describe, expect, it } from 'vitest';
import { applyManagedAuthorityCommand } from '../authority-service';

/** A database that fails the test the moment anything reads or writes it. */
const untouchable = new Proxy(
  {},
  {
    get(_target, key) {
      throw new Error(`the database was touched (${String(key)})`);
    },
  }
);

describe('replace_extension_grants on this service', () => {
  it('is refused, and nothing is stored', async () => {
    const result = await applyManagedAuthorityCommand(
      untouchable as never,
      { tenantId: 'tenant-a', instanceId: 'instance-a' } as never,
      {
        version: 1,
        commandId: 'cmd-ext-1',
        managedConnectionId: 'managed-1',
        scopeVersion: 1,
        kind: 'replace_extension_grants',
        extensionId: 'flow-owner',
        access: 'read',
        revisions: [],
      }
    );
    expect(result).toEqual({
      status: {
        version: 1,
        commandId: 'cmd-ext-1',
        managedConnectionId: 'managed-1',
        scopeVersion: 1,
        state: 'rejected',
        rejectionCode: 'revision_unavailable',
      },
      conflict: false,
    });
  });
});
