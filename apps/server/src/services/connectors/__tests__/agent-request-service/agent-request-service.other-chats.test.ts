import { describe, expect, it } from 'vitest';
import { connectorAgentRequests } from '@dorkos/db';
import {
  OWNER,
  INPUT,
  READ_WRITE,
  principal,
  useAgentRequestHarness,
} from './agent-request-service.fixtures.js';

/** What one chat sees of a request another chat of the same agent opened, and what the agent is handed. */
describe('ConnectorAgentRequestService', () => {
  const h = useAgentRequestHarness();

  describe('the same app asked for in another chat', () => {
    it('refuses the same app from another chat with where to answer it', async () => {
      const requests = h.service();
      await requests.create(principal(), INPUT);

      await expect(
        requests.create(principal({ canonicalSessionId: 'session-2' }), INPUT)
      ).rejects.toMatchObject({
        code: 'request_open_elsewhere',
        message: expect.stringContaining('You already asked for Gmail in another chat'),
      });
      expect(h.db.select().from(connectorAgentRequests).all()).toHaveLength(1);
    });

    it('never promises another chat’s narrower ask covers what this chat needs', async () => {
      const requests = h.service();
      await requests.create(principal(), INPUT);
      const refusal = await requests
        .create(principal({ canonicalSessionId: 'session-2' }), READ_WRITE)
        .then(
          () => new Error('expected a refusal'),
          (error: Error) => error
        );
      expect(refusal).toMatchObject({ code: 'request_open_elsewhere' });
      expect(refusal.message).toContain('That request asks only to read Gmail.');
      expect(refusal.message).not.toContain('you can use Gmail in this chat too');
    });
  });

  it('never hands the agent a link into DorkOS', async () => {
    const requests = h.service();
    const created = await requests.create(principal(), INPUT);
    expect(JSON.stringify(created)).not.toMatch(/https?:\/\//);
    expect(created).not.toHaveProperty('openUrl');
  });

  it("lists only one conversation's requests when asked for its session", async () => {
    const requests = h.service();
    await requests.create(principal(), INPUT);
    await requests.create(principal({ canonicalSessionId: 'session-2' }), {
      ...INPUT,
      serviceSlug: 'slack',
      reason: 'Something else',
    });

    expect(requests.listForOwner(OWNER, undefined, 'session-2')).toMatchObject([
      { sessionId: 'session-2', reason: 'Something else' },
    ]);
    expect(requests.listForOwner(OWNER)).toHaveLength(2);
  });
});
