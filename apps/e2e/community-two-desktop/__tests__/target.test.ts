import { describe, expect, it, vi } from 'vitest';
import type { RemoteHandoff } from '../config.js';
import type { CommunityServer } from '../infra.js';
import { prepareTarget, type InfraStarter } from '../target.js';

const handoff: RemoteHandoff = {
  origin: 'https://community.example.test',
  communityId: 'c',
  channelId: 'ch',
  owner: { email: 'o@example.test', password: 'p' },
  member: { email: 'm@example.test', password: 'q' },
  inviteLink: 'https://community.example.test/c/c/join#invite=t',
};

function fakeInfra() {
  const server = (name: string) =>
    ({ name, origin: `http://127.0.0.1/${name}` }) as CommunityServer;
  return {
    startPostgres: vi.fn(async () => undefined),
    startCommunity: vi.fn(async (name: string) => server(name)),
  } satisfies InfraStarter;
}

describe('two-Desktop target', () => {
  it('remote mode never builds or starts any infrastructure', async () => {
    // Catches remote mode starting Postgres or a Community server beside a live one.
    const infra = fakeInfra();
    const makeInfra = vi.fn(() => infra);
    const { target, infra: built } = await prepareTarget(handoff, makeInfra);
    expect(makeInfra).not.toHaveBeenCalled();
    expect(infra.startPostgres).not.toHaveBeenCalled();
    expect(infra.startCommunity).not.toHaveBeenCalled();
    expect(built).toBeNull();
    expect(target).toEqual({ mode: 'remote', handoff });
  });

  it('local mode starts Postgres and both communities, the proof one with a one-agent limit', async () => {
    // Pins the local run's setup so the refactor into prepareTarget changed nothing.
    const infra = fakeInfra();
    const { target, infra: built } = await prepareTarget(null, () => infra);
    expect(built).toBe(infra);
    expect(infra.startPostgres).toHaveBeenCalledOnce();
    expect(infra.startCommunity.mock.calls).toEqual([
      ['proof', { COMMUNITY_AGENTS_PER_OWNER: '1' }],
      ['isolation'],
    ]);
    expect(target.mode).toBe('local');
  });
});
