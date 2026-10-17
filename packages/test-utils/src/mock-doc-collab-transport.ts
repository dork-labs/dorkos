/**
 * The live doc methods of a mock `Transport` (DOR-2984), kept in their own file
 * and spread into `createMockTransport`. By default the server answers as one
 * with Docs off: every doc socket is refused with a 404, so an editor falls
 * back to saving the file, and no doc has a saved version.
 *
 * @module test-utils/mock-doc-collab-transport
 */
import { vi } from 'vitest';
import type { DocCollabTransport } from '@dorkos/shared/transport-doc-collab';

/** Mock live doc methods: every socket refused, no saved versions. */
export function createMockDocCollabTransport(): DocCollabTransport {
  return {
    connectDocCollab: vi.fn().mockImplementation((_doc, handlers) => {
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        closed = true;
        handlers.onClose({ status: 404 });
      });
      return {
        send: vi.fn(),
        close: vi.fn(() => {
          if (closed) return;
          closed = true;
          handlers.onClose({});
        }),
      };
    }),
    listDocVersions: vi.fn().mockResolvedValue({ versions: [] }),
    keepDocDraft: vi.fn().mockResolvedValue({ ok: true, version: null }),
    restoreDocVersion: vi.fn().mockResolvedValue({ ok: true, live: false }),
  };
}
