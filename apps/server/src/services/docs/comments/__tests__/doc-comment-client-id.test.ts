/**
 * The dispatcher holds a doc comment's queued wake to its ceiling at launch,
 * and fails closed to the runtime's default when a restart lost it (DOR-2983).
 */
import { describe, expect, it } from 'vitest';
import { launchCeiling } from '../../../session/message-dispatcher/state.js';
import {
  DOC_COMMENT_BOUNDED_CLIENT_ID,
  DOC_COMMENT_OWNER_CLIENT_ID,
} from '../doc-comment-client-id.js';

const LEVEL = { asks: 'sometimes', reach: 'project' } as never;

describe('a doc comment wake at launch', () => {
  it("keeps the ceiling a bounded wake was sent with, or the runtime's default without one", () => {
    expect(launchCeiling(DOC_COMMENT_BOUNDED_CLIENT_ID, 'm1', LEVEL)).toBe(LEVEL);
    expect(launchCeiling(DOC_COMMENT_BOUNDED_CLIENT_ID, 'm1', undefined)).toBe('runtime-default');
  });

  it("adds nothing to the owner's own wake", () => {
    expect(launchCeiling(DOC_COMMENT_OWNER_CLIENT_ID, 'm1', undefined)).toBeUndefined();
  });
});
