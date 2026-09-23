import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';
import {
  PASSWORD,
  composer,
  connectDesktop,
  connections,
  destinations,
  escapeRegExp,
  externalOpens,
  feed,
  json,
  openManageMenu,
  openSwitcher,
  send,
  type Desktop,
} from './desktop.js';
import { COMMUNITY, type World } from './world.js';

/**
 * Steps 24-29: ownership transfer between the two people, Disconnect and
 * Leave from the switcher's Manage menu, an expired invitation, removal by
 * the owner, and a last check for local lookups of Community rooms.
 *
 * @module community-two-desktop/steps-lifecycle
 */

/**
 * Run steps 24-29.
 *
 * @param w - The journey so far.
 */
export async function lifecycleSteps(w: World): Promise<void> {
  const {
    ctx,
    step,
    shot,
    findings,
    a,
    b,
    owner,
    member,
    communityOrigin,
    communityId,
    refA,
    refIso,
    stamp,
    openGeneral,
    seeNewest,
    noLocalLookups,
    createInvite,
    productCheck,
  } = w;
  let refB = w.refB;
  /** Open a Community settings section on its own site, as the switcher's links do. */
  async function settings(page: Page, section: string) {
    await page.goto(`${communityOrigin}/c/${communityId}/settings/${section}`);
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({
      timeout: 30_000,
    });
  }
  /**
   * Read a Community API as the person signed in to this browser. It goes
   * through the browser context's cookies, not the page, so a page that is
   * navigating away (as it does right after leaving) cannot break the read.
   */
  async function readAs<T>(page: Page, apiPath: string): Promise<T | null> {
    const response = await page.context().request.get(`${communityOrigin}${apiPath}`);
    return response.ok() ? ((await response.json()) as T) : null;
  }
  const directory = (page: Page) =>
    readAs<{ members: Array<{ displayName: string; role: string }> }>(
      page,
      '/api/v1/members?limit=50'
    ).then((body) => body?.members ?? null);
  async function transfer(from: Page, to: string) {
    await settings(from, 'account');
    await from.locator('#successor').selectOption({ label: to });
    await from.locator('#transfer-password').fill(PASSWORD);
    await from.getByRole('button', { name: 'Transfer ownership', exact: true }).click();
    await expect(from.getByRole('status')).toContainText('Ownership transferred.', {
      timeout: 30_000,
    });
  }

  await step('24 ownership moves from A to B and back; an owner cannot simply leave', async () => {
    await settings(owner, 'account');
    await expect(owner.getByText('Transfer ownership before you leave.')).toBeVisible();
    const blocked = await shot(owner, '24a-owner-leave-blocked-transfer-first');
    await transfer(owner, 'Desktop B');
    // A is now a member, so A's own page offers leaving instead of transfer.
    await expect(owner.getByRole('button', { name: 'Leave community', exact: true })).toBeVisible();
    await expect(owner.locator('#successor')).toHaveCount(0);
    const roles = Object.fromEntries(
      ((await directory(member)) ?? []).map((m) => [m.displayName, m.role])
    );
    assert.equal(roles['Desktop B'], 'owner', 'B owns the community');
    assert.equal(roles['Desktop A'], 'member', 'A is an ordinary member');
    await settings(member, 'account');
    const bOwner = await shot(member, '24b-desktop-b-now-owner');
    await transfer(member, 'Desktop A');
    const back = Object.fromEntries(
      ((await directory(owner)) ?? []).map((m) => [m.displayName, m.role])
    );
    assert.equal(back['Desktop A'], 'owner', 'A owns it again');
    assert.equal(back['Desktop B'], 'member', 'B is a member again');
    // Both apps kept working through both transfers.
    assert.equal((await connections(a)).find((c) => c.ref === refA)?.status, 'connected');
    assert.equal((await connections(b)).find((c) => c.ref === refB)?.status, 'connected');
    return { roles, back, blocked, bOwner, restored: await shot(owner, '24c-owner-restored') };
  });

  const grants = (page: Page) =>
    readAs<{ grants: Array<{ installName: string }> }>(page, '/api/v1/me/grants').then(
      (body) => body?.grants.map((g) => g.installName) ?? null
    );
  const memberCanRead = async (page: Page) =>
    (await page.context().request.get(`${communityOrigin}/api/v1/channels`)).status();

  await step(
    '25 Disconnect from the switcher’s Manage menu ends only this app’s connection; B stays a member',
    async () => {
      // Baseline, so the revocation check below can fail for the right reason only.
      const grantsBefore = await grants(member);
      assert(
        grantsBefore?.includes('Desktop B'),
        `Desktop B holds a grant before disconnecting (${JSON.stringify(grantsBefore)})`
      );
      await openGeneral(b, refB);
      await openManageMenu(b, COMMUNITY);
      await b.page.waitForTimeout(300);
      const menuShot = await shot(b.page, '25a-desktop-b-manage-menu');
      await b.page.getByRole('menuitem', { name: /^Disconnect/ }).click();
      const confirm = b.page.getByRole('alertdialog', {
        name: `Disconnect this DorkOS from ${COMMUNITY}?`,
      });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(`You stay a member of ${COMMUNITY}`);
      const dialogShot = await shot(b.page, '25b-desktop-b-disconnect-confirm');
      await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(confirm).toBeHidden({ timeout: 30_000 });
      await expect(b.page).not.toHaveURL(/community=/, { timeout: 30_000 });
      await expect.poll(async () => (await connections(b)).some((c) => c.ref === refB)).toBe(false);
      await openSwitcher(b);
      await expect(destinations(b).filter({ hasText: COMMUNITY })).toHaveCount(0);
      await b.page.keyboard.press('Escape');
      const after = await shot(b.page, '25c-desktop-b-disconnected');
      // B is still a member on the Community, and only the Desktop B grant is gone.
      assert.equal(await memberCanRead(member), 200, 'B still reads the community in the browser');
      let remaining: string[] | null = null;
      await productCheck(
        'Disconnect revokes this installation’s grant on the Community',
        'Spec community-membership-journeys, "Connect this DorkOS installation": “Disconnect this installation” ' +
          'revokes only the selected grant and deletes its local credential. Repro: connect a DorkOS app to a ' +
          'Community, choose Manage <community> > Disconnect… > Disconnect in the app, then open the Community’s ' +
          'Settings > Account > Local connections (or GET /api/v1/me/grants): the installation’s grant is still listed.',
        async () => {
          await expect
            .poll(async () => (remaining = await grants(member))?.includes('Desktop B'), {
              timeout: 20_000,
            })
            .toBe(false);
        }
      );
      // A is untouched.
      await openGeneral(a, refA);
      const stillA = `A is unaffected by B's disconnect ${stamp}`;
      await send(composer(a), stillA);
      await seeNewest(a, stillA);
      // Connecting again is a fresh pairing, and it works.
      refB = await connectDesktop(b, member, communityOrigin, COMMUNITY, 'Desktop B', null);
      await openGeneral(b, refB);
      await expect(feed(b)).toContainText(stamp, { timeout: 30_000 });
      return {
        menuShot,
        dialogShot,
        after,
        grantsBefore,
        grantsAfterDisconnect: remaining,
        reconnectedRef: refB,
      };
    }
  );

  /** Wait until an app no longer holds a live connection to the Community, and has moved off it. */
  async function lostAccess(local: Desktop, ref: string, why: string) {
    const since = Date.now();
    // The app sees revocation the next time its local server talks to the Community.
    await expect
      .poll(
        async () => {
          await fetch(`${local.origin}/api/communities/${ref}/rooms`).catch(() => undefined);
          return (await connections(local)).find((c) => c.ref === ref)?.status ?? 'removed';
        },
        { timeout: 90_000 }
      )
      .not.toBe('connected');
    const status = (await connections(local)).find((c) => c.ref === ref)?.status ?? 'removed';
    const rooms = await fetch(`${local.origin}/api/communities/${ref}/rooms`);
    assert(!rooms.ok, `the app can still read the community (${rooms.status})`);
    const serverKnewMs = Date.now() - since;
    // The window learns from its connection-list poll, so moving off can trail the server.
    await expect(local.page).not.toHaveURL(new RegExp(`community=${escapeRegExp(ref)}`), {
      timeout: 60_000,
    });
    await expect(feed(local)).toHaveCount(0);
    const routedAwayMs = Date.now() - since;
    findings.push({
      check: `After ${why}, the open window leaves the Community within 10s`,
      serverKnewMs,
      routedAwayMs,
      pass: routedAwayMs <= 10_000,
    });
    return { status, roomsStatus: rooms.status, serverKnewMs, routedAwayMs };
  }

  await step(
    '26 Leave community from the Manage menu opens the Community’s own page; leaving ends B’s access',
    async () => {
      await openGeneral(b, refB);
      const before = (await externalOpens(b)).length;
      await openManageMenu(b, COMMUNITY);
      await b.page.getByRole('menuitem', { name: /^Leave community/ }).click();
      await expect.poll(async () => (await externalOpens(b)).length).toBe(before + 1);
      const opened = (await externalOpens(b))[before]!;
      assert.equal(
        opened,
        `${communityOrigin}/c/${communityId}/settings/account`,
        'Leave opens the Community’s account page'
      );
      // The app did not end anything itself: B is still connected until B confirms on the Community.
      assert.equal((await connections(b)).find((c) => c.ref === refB)?.status, 'connected');
      await member.goto(opened);
      await member.locator('#leave-community-name').fill(COMMUNITY);
      await member.locator('#leave-password').fill(PASSWORD);
      const leaveShot = await shot(member, '26a-member-leave-review');
      await member.getByRole('button', { name: 'Leave community', exact: true }).click();
      await expect.poll(() => memberCanRead(member), { timeout: 30_000 }).not.toBe(200);
      const access = await lostAccess(b, refB, 'leaving');
      const bShot = await shot(b.page, '26b-desktop-b-after-leaving');
      const roles = ((await directory(owner)) ?? []).map((m) => m.displayName);
      assert(!roles.includes('Desktop B'), 'B is no longer in the member directory');
      // A and A's other community are untouched.
      await openGeneral(a, refA);
      assert.deepEqual(
        (await connections(a)).map((c) => c.status),
        ['connected', 'connected'],
        'both of A’s connections stay connected'
      );
      await json(`${a.origin}/api/communities/${refIso}/rooms`);
      return { opened, leaveShot, access, bShot };
    }
  );

  await step('27 an expired invitation is refused and admits no one', async () => {
    await settings(owner, 'community');
    const link = await createInvite(owner);
    const inviteId = /invite=\d+\.v\d+\.([0-9a-f-]{36})\./.exec(decodeURIComponent(link))?.[1];
    assert(inviteId, 'the invite token names its id');
    // Let the invitation's time run out: move its stored expiry into the past.
    ctx.infra.sql(
      ctx.proof.database,
      `UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = '${inviteId}'`
    );
    assert.equal(
      ctx.infra.sql(
        ctx.proof.database,
        `SELECT count(*) FROM invites WHERE id = '${inviteId}' AND expires_at < now()`
      ),
      '1'
    );
    const membersBefore = ((await directory(owner)) ?? []).length;
    // A fresh document: two invite links differ only in their #fragment, and a
    // fragment-only goto would not load the page again.
    await member.goto('about:blank');
    await member.goto(link);
    await member.getByRole('button', { name: 'Continue', exact: true }).click();
    const alert = member.getByRole('alert');
    // The spec's one public failure shape for every unusable invitation.
    await expect(alert).toContainText('This invitation cannot be used.', { timeout: 30_000 });
    await expect(member.getByRole('heading', { name: `You’re in ${COMMUNITY}.` })).toHaveCount(0);
    assert.notEqual(await memberCanRead(member), 200, 'an expired invite admitted B');
    assert.equal(
      ((await directory(owner)) ?? []).length,
      membersBefore,
      'membership did not change'
    );
    return {
      refusal: (await alert.innerText()).trim(),
      screenshot: await shot(member, '27-member-expired-invite-refused'),
    };
  });

  await step(
    '28 B rejoins and reconnects; the owner removes B and B’s app loses access cleanly',
    async () => {
      await settings(owner, 'community');
      const link = await createInvite(owner);
      // A fresh document: two invite links differ only in their #fragment, and a
      // fragment-only goto would not load the page again.
      await member.goto('about:blank');
      await member.goto(link);
      await member.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(member.getByRole('heading', { name: `You’re in ${COMMUNITY}.` })).toBeVisible({
        timeout: 30_000,
      });
      await member.getByRole('button', { name: 'Open community', exact: true }).click();
      // A later invitation restores membership, never the old machine authority: B pairs again.
      assert(!(await connections(b)).some((c) => c.ref === refB && c.status === 'connected'));
      refB = await connectDesktop(b, member, communityOrigin, COMMUNITY, 'Desktop B', null);
      await openGeneral(b, refB);
      const rejoined = await shot(b.page, '28a-desktop-b-rejoined');
      // The owner removes B.
      await settings(owner, 'members');
      await owner
        .getByRole('button', { name: 'Remove Desktop B from community', exact: true })
        .click();
      await expect(owner.getByRole('status')).toContainText('Member removed.', { timeout: 30_000 });
      const removedShot = await shot(owner, '28b-owner-removed-b');
      const access = await lostAccess(b, refB, 'removal');
      assert.notEqual(
        await memberCanRead(member),
        200,
        'the removed member still reads the community'
      );
      const bShot = await shot(b.page, '28c-desktop-b-after-removal');
      // A and A's Isolation Proof are untouched.
      await openGeneral(a, refA);
      const stillA = `A is unaffected by B's removal ${stamp}`;
      await send(composer(a), stillA);
      await seeNewest(a, stillA);
      await json(`${a.origin}/api/communities/${refIso}/rooms`);
      return {
        rejoined,
        removedShot,
        access,
        bShot,
        aShot: await shot(a.page, '28d-desktop-a-unaffected'),
      };
    }
  );

  await step(
    '29 still no local /api/rooms lookup of any community room id, private channel included',
    noLocalLookups
  );
}
