/**
 * The doc comments slice of the mock Transport (DOR-2983), spread into
 * `createMockTransport` the way the Transport port extends
 * `DocCommentTransport`.
 *
 * @module test-utils/mock-doc-comments
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The doc comment methods of the Transport port. */
type DocCommentMethods = Pick<
  Transport,
  | 'listDocCommentThreads'
  | 'listDocCommentMentionable'
  | 'createDocCommentThread'
  | 'replyDocComment'
  | 'setDocCommentThreadResolved'
  | 'editDocComment'
  | 'updateDocCommentAnchors'
>;

/**
 * Mock doc comment methods: a doc with no threads, nobody to mention, an
 * anchor save that takes every update, and writes a test must stub before
 * using.
 */
export function docCommentTransportMocks(): DocCommentMethods {
  return {
    listDocCommentThreads: vi.fn().mockResolvedValue({ threads: [] }),
    listDocCommentMentionable: vi.fn().mockResolvedValue({ people: [] }),
    createDocCommentThread: vi
      .fn()
      .mockRejectedValue(new Error('createDocCommentThread not mocked')),
    replyDocComment: vi.fn().mockRejectedValue(new Error('replyDocComment not mocked')),
    setDocCommentThreadResolved: vi
      .fn()
      .mockRejectedValue(new Error('setDocCommentThreadResolved not mocked')),
    editDocComment: vi.fn().mockRejectedValue(new Error('editDocComment not mocked')),
    updateDocCommentAnchors: vi
      .fn()
      .mockImplementation((body: { updates: unknown[] }) =>
        Promise.resolve({ updated: body.updates.length })
      ),
  };
}
