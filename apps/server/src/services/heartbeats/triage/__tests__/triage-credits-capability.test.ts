/**
 * `heartbeat.choose_triage_credits` on `PUT /api/heartbeats/triage-credits`
 * (spec `heartbeats` §6.3): only the owner answers the credits offer, never an
 * agent, and the answer is recorded only when it changes. With no owner
 * account there is no password to confirm with, so the front-door bar alone
 * stands and Use credits runs at once; the held flow is in
 * `routes/__tests__/capability-confirm-first.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The chain these routes run behind reads config and the tunnel per request.
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../../core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

const refusal = vi.hoisted(() => ({
  value: undefined as undefined | 'not-a-person' | 'not-the-owner',
}));
// The front-door bar stays real; only the owner answer is set here.
vi.mock('../../../../lib/caller-authority.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/caller-authority.js')>()),
  refuseUnlessAccountOwner: () => refusal.value,
}));

import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { heartbeatDomain } from '../../heartbeat-capabilities.js';
import { setTriageCreditsChoiceStore } from '../triage-credits-capability.js';

const PATH = '/api/heartbeats/triage-credits';
const target = swappableServer();
let choice: boolean | null;
let records: Array<[boolean | null, boolean]>;

beforeEach(() => {
  choice = null;
  records = [];
  refusal.value = undefined;
  setTriageCreditsChoiceStore({
    choice: () => choice,
    setChoice: (next) => {
      choice = next;
    },
    record: (before, after) => records.push([before, after]),
  });
  target.mount(honoGroupListener([capabilityGroup(heartbeatDomain)]));
});
afterEach(() => setTriageCreditsChoiceStore(undefined));

describe('PUT /api/heartbeats/triage-credits', () => {
  it('stores Use credits and Not now, recording each change once', async () => {
    const yes = await request(target.server).put(PATH).send({ useCredits: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ useCredits: true });
    expect(choice).toBe(true);
    await request(target.server).put(PATH).send({ useCredits: true });
    await request(target.server).put(PATH).send({ useCredits: false });
    expect(choice).toBe(false);
    expect(records).toEqual([
      [null, true],
      [true, false],
    ]);
  });

  it('refuses an agent, and a person who does not own this DorkOS, in the route’s own words', async () => {
    refusal.value = 'not-a-person';
    const agent = await request(target.server).put(PATH).send({ useCredits: false });
    expect(agent.status).toBe(403);
    expect(agent.body).toMatchObject({
      code: 'person_only',
      detail: 'Only you can choose what pays for checks, from the DorkOS app.',
    });
    refusal.value = 'not-the-owner';
    const other = await request(target.server).put(PATH).send({ useCredits: true });
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({
      code: 'owner_only',
      detail: 'Only the owner of this DorkOS can choose what pays for checks.',
    });
    expect(choice).toBeNull();
    expect(records).toEqual([]);
  });

  it('refuses anything carrying an Authorization header as not a person, whatever the owner bar says', async () => {
    const res = await request(target.server)
      .put(PATH)
      .set('Authorization', 'Bearer dork_made_up')
      .send({ useCredits: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(choice).toBeNull();
  });

  it('refuses a body that is not an answer', async () => {
    const res = await request(target.server).put(PATH).send({ useCredits: 'yes' });
    expect(res.status).toBe(400);
    expect(choice).toBeNull();
  });
});
