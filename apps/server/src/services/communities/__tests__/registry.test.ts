/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { LOCAL_COMMUNITY, type CommunityRef } from '@dorkos/shared/community-adapter';
import { FakeCommunityAdapter } from '@dorkos/test-utils/fake-community-adapter';
import { CommunityNotRegisteredError, CommunityRegistry } from '../registry.js';

/** A second community, addressed by a ULID the way a real one would be. */
const REMOTE = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB' as CommunityRef;

describe('CommunityRegistry', () => {
  it('dispatches on the community, and never falls back to local', () => {
    const registry = new CommunityRegistry();
    const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    registry.register(local, 'This machine');

    expect(registry.get(LOCAL_COMMUNITY)).toBe(local);

    // Masking a mismatch would hide a routing bug — and here it would answer a
    // question about someone else's community with this machine's own rooms.
    expect(() => registry.get(REMOTE)).toThrow(CommunityNotRegisteredError);
    expect(registry.has(REMOTE)).toBe(false);
  });

  it('remembers a connection result, because a listing needs it afterwards', async () => {
    const registry = new CommunityRegistry();
    registry.register(
      new FakeCommunityAdapter({ community: REMOTE, type: 'buzz', connectStatus: 'not-admitted' }),
      'Dork Labs'
    );

    expect(registry.getConnection(REMOTE)).toBeUndefined();

    const connection = await registry.connect(REMOTE);
    expect(connection.status).toBe('not-admitted');
    expect(connection.disclosure).toBeTruthy();
    expect(registry.getConnection(REMOTE)).toEqual(connection);
  });

  it('never rejects for a connection outcome — only for an unregistered ref', async () => {
    const registry = new CommunityRegistry();
    registry.register(
      new FakeCommunityAdapter({ community: REMOTE, connectStatus: 'unreachable' }),
      'Dork Labs'
    );

    await expect(registry.connect(REMOTE)).resolves.toMatchObject({ status: 'unreachable' });
    await expect(registry.connect(LOCAL_COMMUNITY)).rejects.toBeInstanceOf(
      CommunityNotRegisteredError
    );
  });
});
