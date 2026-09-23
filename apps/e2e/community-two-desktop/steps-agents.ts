import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  composer,
  connections,
  destinations,
  feed,
  json,
  launchDesktop,
  openSwitcher,
  sendJson,
  switchTo,
  timeline,
  trigger,
  type Desktop,
} from './desktop.js';
import { COMMUNITY, PRIVATE_CHANNEL, type Entry, type Room, type World } from './world.js';

/**
 * Steps 20-23: each member enrolls their own local agent under the
 * Community's agent limit, a private channel admits only its members and
 * their agents, a mention is answered by the scripted test runtime (no model,
 * no spend), and a packaged app restarts mid-journey and resumes.
 *
 * @module community-two-desktop/steps-agents
 */

/**
 * Run steps 20-23.
 *
 * @param w - The journey so far.
 */
export async function agentSteps(w: World): Promise<void> {
  const {
    ctx,
    step,
    shot,
    findings,
    a,
    b,
    owner,
    communityOrigin,
    communityId,
    refA,
    room,
    stamp,
    fillers,
    communityRoomIds,
    openGeneral,
    seeNewest,
    scrollUpAndRemember,
    resize,
    productCheck,
  } = w;
  const refB = w.refB;
  interface Enrollments {
    agents: Array<{
      localAgentId: string;
      remoteMemberId: string;
      displayName: string;
      roomIds: string[];
      active: boolean;
    }>;
  }
  const enrollments = (local: Desktop, ref: string) =>
    json<Enrollments>(`${local.origin}/api/communities/${ref}/agents`);
  /** Register a local agent in this app's own home, the way a person adds a project folder. */
  async function registerAgent(local: Desktop, name: string) {
    const scanRoot = path.join(local.home, 'agents');
    const agentPath = path.join(scanRoot, name.toLowerCase().replace(/\s+/g, '-'));
    mkdirSync(agentPath, { recursive: true });
    return json<{ id: string; name: string }>(
      `${local.origin}/api/mesh/agents`,
      sendJson('POST', {
        path: agentPath,
        scanRoot,
        overrides: { name, runtime: 'claude-code', behavior: { responseMode: 'silent' } },
      })
    );
  }
  const agentsRegion = (local: Desktop) =>
    local.page.getByRole('region', { name: 'My community agents' });
  async function openAgents(local: Desktop, ref: string, roomId: string) {
    await local.page.goto(`${local.origin}/channels?community=${ref}&id=${roomId}`);
    await agentsPanel(local);
  }
  /** Show the Members panel with the agent controls; it can close when the channel header re-renders. */
  async function agentsPanel(local: Desktop) {
    const members = local.page.getByRole('button', { name: 'Members', exact: true });
    await expect(async () => {
      if (!(await agentsRegion(local).isVisible())) await members.click();
      await expect(agentsRegion(local)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30_000 });
  }
  /** Choose a local agent in the picker and add it; returns the enroll response status. */
  async function enrollInUi(
    local: Desktop,
    ref: string,
    agent: { id: string; name: string },
    handle: string
  ) {
    await agentsPanel(local);
    const region = agentsRegion(local);
    await region.getByLabel('Local agent').click();
    await local.page.getByRole('option', { name: agent.name, exact: true }).click();
    await region.getByLabel('Community handle (optional)').fill(handle);
    const enrolled = local.page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname ===
          `/api/communities/${ref}/agents/${encodeURIComponent(agent.id)}/enroll`
    );
    await region.getByRole('button', { name: 'Add to community', exact: true }).click();
    return (await enrolled).status();
  }
  async function joinChannelInUi(
    local: Desktop,
    ref: string,
    roomId: string,
    agent: { id: string; name: string; display?: string }
  ) {
    await agentsPanel(local);
    const card = agentsRegion(local)
      .locator('div.rounded-md')
      .filter({ hasText: agent.display ?? agent.name });
    const joined = local.page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname ===
          `/api/communities/${ref}/rooms/${roomId}/agents/${encodeURIComponent(agent.id)}/membership`
    );
    await card.getByRole('button', { name: 'Join channel', exact: true }).click();
    assert.equal((await joined).status(), 204, `${agent.name} joins the channel`);
    await expect(card.getByRole('button', { name: 'Leave channel', exact: true })).toBeVisible();
  }

  // `name` is the local registry's name (what the picker offers); `display` is the
  // name the Community shows once the agent is enrolled.
  let aAgent: { id: string; name: string; display?: string } | undefined;
  let bAgent: { id: string; name: string; display?: string } | undefined;
  await step(
    '20 each member chooses their own local agent; the per-member agent limit holds',
    async () => {
      // B was left at phone width by step 18.
      await resize(b, 1280, 860);
      aAgent = await registerAgent(a, 'A Helper');
      bAgent = await registerAgent(b, 'B Helper');
      const bSpare = await registerAgent(b, 'B Spare');
      const evidence: Record<string, unknown> = {};
      for (const [local, ref, agent, handle, others] of [
        [a, refA, aAgent, 'a-helper', [bAgent.name, bSpare.name]],
        [b, refB, bAgent, 'b-helper', [aAgent.name]],
      ] as const) {
        await openAgents(local, ref, room.roomId);
        // Each person picks from their OWN installation's agents, never the other person's.
        await agentsRegion(local).getByLabel('Local agent').click();
        const options = local.page.getByRole('option');
        await expect(options.filter({ hasText: agent.name })).toBeVisible();
        for (const other of others) await expect(options.filter({ hasText: other })).toHaveCount(0);
        const offered = await options.allInnerTexts();
        await local.page.keyboard.press('Escape');
        assert.equal(await enrollInUi(local, ref, agent, handle), 201, `${agent.name} enrolls`);
        let enrolled: Enrollments['agents'][number] | undefined;
        await expect
          .poll(
            async () =>
              (enrolled = (await enrollments(local, ref)).agents.find(
                (x) => x.localAgentId === agent.id && x.active
              )),
            { timeout: 30_000 }
          )
          .toBeTruthy();
        agent.display = enrolled!.displayName;
        await agentsPanel(local);
        await expect(agentsRegion(local)).toContainText(`${agent.display} · owned by`, {
          timeout: 30_000,
        });
        await joinChannelInUi(local, ref, room.roomId, agent);
        evidence[local.name] = {
          offered,
          screenshot: await shot(local.page, `20a-${local.name}-agent-enrolled`),
        };
      }
      // The Community runs with one active agent per member: B's second agent is refused, visibly.
      const status = await enrollInUi(b, refB, bSpare, 'b-spare');
      assert(status >= 400, `a second agent past the limit is refused (got ${status})`);
      const alert = agentsRegion(b).getByRole('alert');
      await expect(alert).toBeVisible({ timeout: 15_000 });
      await alert.scrollIntoViewIfNeeded();
      const refusal = (await alert.innerText()).trim();
      await productCheck(
        'An agent past the limit is refused with a reason the person can act on',
        'The Community refuses the enrollment with 429 "Active agent limit reached." ' +
          '(apps/community/src/routes/agents.ts), but the DorkOS app answers POST ' +
          '/api/communities/:ref/agents/:localAgentId/enroll with 502 "Community unavailable." because fail() in ' +
          'apps/server/src/routes/remote-communities.ts maps every unrecognised Community refusal to 502. Repro: run a ' +
          'Community with COMMUNITY_AGENTS_PER_OWNER=1, enroll one local agent from the channel Members panel, then ' +
          'add a second: the panel says "Community unavailable." while the Community is up.',
        async () => {
          assert(status < 500, `enroll refusal is a ${status}`);
          assert(!/unavailable/i.test(refusal), `the panel says "${refusal}"`);
        }
      );
      const bActive = (await enrollments(b, refB)).agents.filter((x) => x.active);
      assert.deepEqual(
        bActive.map((x) => x.localAgentId),
        [bAgent.id],
        'B keeps exactly one active agent'
      );
      const aActive = (await enrollments(a, refA)).agents.filter((x) => x.active);
      assert.deepEqual(
        aActive.map((x) => x.localAgentId),
        [aAgent.id],
        'A’s limit is A’s own'
      );
      return {
        ...evidence,
        limitStatus: status,
        refusal,
        limitShot: await shot(b.page, '20b-desktop-b-agent-limit-refused'),
      };
    }
  );

  await step('21 a private channel admits only its members and their agents', async () => {
    await owner.goto(`${communityOrigin}/c/${communityId}/settings/community`);
    await owner.locator('#channel-new-name').fill(PRIVATE_CHANNEL);
    await owner.locator('#channel-visibility').selectOption('private');
    await owner.getByRole('button', { name: 'Create channel', exact: true }).click();
    await expect(owner.getByRole('status')).toContainText('Channel created.');
    let found: Room | undefined;
    await expect
      .poll(
        async () => {
          found = (
            await json<{ rooms: Room[] }>(`${a.origin}/api/communities/${refA}/rooms`)
          ).rooms.find((x) => x.title === PRIVATE_CHANNEL);
          return Boolean(found);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    const priv = found!;
    communityRoomIds.push(priv.roomId);
    // A, a member of the private channel, adds A's agent there from A's app.
    await openAgents(a, refA, priv.roomId);
    await joinChannelInUi(a, refA, priv.roomId, aAgent!);
    const aShot = await shot(a.page, '21a-desktop-a-private-channel-agent-joined');
    // B is not a member: the channel is absent from B's app, unreadable, and B's agent cannot be put there.
    const bRooms = await json<{ rooms: Room[] }>(`${b.origin}/api/communities/${refB}/rooms`);
    assert(
      !bRooms.rooms.some((x) => x.roomId === priv.roomId || x.title === PRIVATE_CHANNEL),
      'B does not see the private channel'
    );
    const read = await fetch(`${b.origin}/api/communities/${refB}/rooms/${priv.roomId}/entries`);
    assert(!read.ok, `B can read the private channel (${read.status})`);
    const put = await fetch(
      `${b.origin}/api/communities/${refB}/rooms/${priv.roomId}/agents/${encodeURIComponent(bAgent!.id)}/membership`,
      { method: 'POST' }
    );
    assert(!put.ok, `B's agent was admitted to a private channel B is not in (${put.status})`);
    findings.push({
      check: 'A non-member’s private-channel request is refused as a refusal, not as an outage',
      readStatus: read.status,
      agentJoinStatus: put.status,
      pass: read.status < 500 && put.status < 500,
    });
    await openAgents(b, refB, room.roomId);
    await expect(b.page.locator('body')).not.toContainText(PRIVATE_CHANNEL);
    const bEnroll = (await enrollments(b, refB)).agents.find((x) => x.localAgentId === bAgent!.id);
    assert(
      bEnroll && !bEnroll.roomIds.includes(priv.roomId),
      'B’s agent holds no private-channel membership'
    );
    return {
      roomId: priv.roomId,
      bReadStatus: read.status,
      bAgentJoinStatus: put.status,
      aShot,
      bShot: await shot(b.page, '21b-desktop-b-no-private-channel'),
    };
  });

  await step('22 A mentions B’s agent; B’s app answers with the scripted test reply', async () => {
    // Wait for B's agent to finish subscribing to #general before addressing it.
    await expect
      .poll(
        async () => {
          const r = await fetch(
            `${b.origin}/api/test/community-subscription?ref=${encodeURIComponent(refB)}&roomId=${encodeURIComponent(room.roomId)}`
          );
          if (!r.ok) return false;
          const body = (await r.json()) as { snapshotComplete?: boolean; replayComplete?: boolean };
          return Boolean(body.snapshotComplete && body.replayComplete);
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await openGeneral(a, refA);
    const ask = `@b-helper please confirm the two-desktop proof ${stamp}`;
    const box = composer(a);
    await box.click();
    await box.fill(ask);
    // Close the @mention completion if it opened, so Enter sends rather than picks.
    if (await a.page.getByRole('listbox').isVisible()) await box.press('Escape');
    await box.press('Enter');
    await expect(feed(a)).toContainText(ask, { timeout: 30_000 });
    let reply: Entry | undefined;
    await expect
      .poll(
        async () => {
          const { entries } = await json<{ entries: Entry[] }>(
            `${a.origin}/api/communities/${refA}/rooms/${room.roomId}/entries?limit=100`
          );
          reply = entries.find(
            (e) =>
              e.authorKind === 'agent' &&
              e.authorDisplayName === bAgent!.display &&
              e.text.startsWith('Echo:')
          );
          return Boolean(reply);
        },
        { timeout: 90_000 }
      )
      .toBe(true);
    assert(reply!.text.includes(stamp), 'the reply answers this run’s mention');
    await seeNewest(a, reply!.text.slice(0, 40));
    await openGeneral(b, refB);
    await seeNewest(b, reply!.text.slice(0, 40));
    return {
      reply: reply!.text.slice(0, 160),
      a: await shot(a.page, '22a-desktop-a-agent-reply'),
      b: await shot(b.page, '22b-desktop-b-agent-reply'),
    };
  });

  await step(
    '23 B’s app restarts mid-journey and resumes: connection, reading position, switcher state',
    async () => {
      await openGeneral(b, refB);
      // Put B at a remembered mid-history row, so resuming it can be told apart from opening at the end.
      await b.page
        .getByRole('button', { name: 'Scroll to bottom' })
        .click()
        .catch(() => undefined);
      const { anchorText } = await scrollUpAndRemember(b, refB, fillers.at(-1)!);
      const navigationBefore = await json(`${b.origin}/api/community-connections/navigation`);
      const destinationBefore = await json(
        `${b.origin}/api/community-connections/navigation/${refB}/destination`
      );
      const beforeShot = await shot(b.page, '23a-desktop-b-before-restart');
      const originBefore = b.origin;
      await b.app.close();
      const relaunched = await launchDesktop(ctx.launch, 'person-b', true);
      // Same person, same home: the handle keeps pointing at B, now the relaunched app.
      Object.assign(b, relaunched);
      const rows = await expect
        .poll(async () => (await connections(b)).find((c) => c.ref === refB)?.status, {
          timeout: 60_000,
        })
        .toBe('connected')
        .then(() => connections(b));
      assert.equal(rows.length, 1, 'B still holds exactly its one connection');
      assert.deepEqual(
        await json(`${b.origin}/api/community-connections/navigation`),
        navigationBefore,
        'switcher order and state survive'
      );
      assert.deepEqual(
        await json(`${b.origin}/api/community-connections/navigation/${refB}/destination`),
        destinationBefore,
        'remembered destination survives'
      );
      await expect(trigger(b)).toBeVisible({ timeout: 60_000 });
      const triggerAfterRestart = await trigger(b).getAttribute('aria-label');
      const urlAfterRestart = b.page.url();
      if (!urlAfterRestart.includes(`community=${refB}`)) {
        await openSwitcher(b);
        await expect(destinations(b).filter({ hasText: COMMUNITY })).toBeVisible();
        await b.page.keyboard.press('Escape');
        await switchTo(b, COMMUNITY);
      }
      await expect(timeline(b)).toHaveAttribute('data-landed-on', 'remembered', {
        timeout: 30_000,
      });
      await expect(feed(b).getByText(anchorText, { exact: true })).toBeInViewport();
      const resumed = await shot(b.page, '23b-desktop-b-resumed-after-restart');
      const after = `After restart from Desktop B ${stamp}`;
      await json(
        `${b.origin}/api/communities/${refB}/rooms/${room.roomId}/entries`,
        sendJson('POST', { text: after, idempotencyKey: randomUUID() })
      );
      await openGeneral(a, refA);
      await seeNewest(a, after);
      const bAgents = (await enrollments(b, refB)).agents
        .filter((x) => x.active)
        .map((x) => x.localAgentId);
      assert.deepEqual(bAgents, [bAgent!.id], 'B’s agent enrollment survives the restart');
      return {
        originBefore,
        originAfter: b.origin,
        triggerAfterRestart,
        urlAfterRestart,
        anchorText,
        beforeShot,
        resumed,
      };
    }
  );
}
