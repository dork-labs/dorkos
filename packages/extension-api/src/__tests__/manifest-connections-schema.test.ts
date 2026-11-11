/**
 * `serverCapabilities.connections` (DOR-3547): the services an extension's
 * server half reads through DorkOS. Read only, each service and operation
 * once, and only for an extension that runs in the subprocess runtime.
 */
import { describe, expect, it } from 'vitest';
import { CONNECTIONS_NEED_SUBPROCESS } from '../connections-declaration.js';
import { ExtensionManifestSchema } from '../manifest-schema.js';

/** A manifest with these server capabilities. */
function manifestWith(serverCapabilities: Record<string, unknown>) {
  return { id: 'flow-owner', name: 'Flow', version: '0.2.0', serverCapabilities };
}

/** Every message the schema refused a manifest with. */
function messagesOf(input: unknown): string[] {
  const result = ExtensionManifestSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const LINEAR = {
  service: 'linear',
  access: 'read',
  operations: ['LINEAR_LIST_LINEAR_PROJECTS', 'LINEAR_GET_LINEAR_PROJECT'],
  why: "Shows each project's health on the Owner view.",
};

describe('serverCapabilities.connections', () => {
  it('accepts declared reads on a subprocess extension', () => {
    const parsed = ExtensionManifestSchema.parse(
      manifestWith({ runtime: 'subprocess', connections: [LINEAR] })
    );
    expect(parsed.serverCapabilities?.connections).toEqual([LINEAR]);
  });

  it('refuses connections on an extension that runs inside DorkOS', () => {
    expect(messagesOf(manifestWith({ connections: [LINEAR] }))).toContain(
      CONNECTIONS_NEED_SUBPROCESS
    );
    expect(messagesOf(manifestWith({ runtime: 'in-process', connections: [LINEAR] }))).toContain(
      CONNECTIONS_NEED_SUBPROCESS
    );
  });

  it('accepts only read access', () => {
    for (const access of ['read-write', 'write', 'destructive', 'READ', undefined]) {
      expect(
        ExtensionManifestSchema.safeParse(
          manifestWith({ runtime: 'subprocess', connections: [{ ...LINEAR, access }] })
        ).success
      ).toBe(false);
    }
  });

  it('refuses a service or an operation listed twice', () => {
    expect(
      messagesOf(manifestWith({ runtime: 'subprocess', connections: [LINEAR, LINEAR] }))
    ).toContain('"linear" is declared more than once');
    expect(
      messagesOf(
        manifestWith({
          runtime: 'subprocess',
          connections: [{ ...LINEAR, operations: ['A_READ', 'A_READ'] }],
        })
      )
    ).toContain('"A_READ" is listed more than once');
  });

  it('refuses empty lists, too many entries, bad ids and unknown keys', () => {
    const bad = [
      [],
      [{ ...LINEAR, operations: [] }],
      [{ ...LINEAR, operations: Array.from({ length: 33 }, (_, i) => `OP_${i}`) }],
      Array.from({ length: 9 }, (_, i) => ({ ...LINEAR, service: `svc-${i}` })),
      [{ ...LINEAR, service: 'Linear' }],
      [{ ...LINEAR, service: 'extension:flow' }],
      [{ ...LINEAR, operations: ['has space'] }],
      [{ ...LINEAR, why: 'x'.repeat(121) }],
      [{ ...LINEAR, token: 'nope' }],
    ];
    for (const connections of bad) {
      expect(
        ExtensionManifestSchema.safeParse(manifestWith({ runtime: 'subprocess', connections }))
          .success
      ).toBe(false);
    }
  });
});
