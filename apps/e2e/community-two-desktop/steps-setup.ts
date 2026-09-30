import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';
import {
  PASSWORD,
  composer,
  connectDesktop,
  connections,
  escapeRegExp,
  feed,
  json,
  launchDesktop,
  type Desktop,
} from './desktop.js';
import { runsStep, type StepId } from './plan.js';
import {
  type JourneyContext,
  COMMUNITY,
  ISOLATION,
  type Entry,
  type Room,
  type World,
} from './world.js';

/**
 * Steps 1-9: two self-hosted Communities are set up in a browser, B joins by
 * invitation, two packaged apps boot in their own homes and connect through
 * the real approval hand-off, and both see the same #general. Also builds the
 * helpers every later stage shares.
 *
 * In remote mode the live gate already did steps 1-3 and there is no second
 * Community, so 1-4 and 8 are skipped: B signs in on the live origin instead
 * (photographed at desktop and phone width), and both apps connect to it.
 *
 * @module community-two-desktop/steps-setup
 */

/**
 * Run steps 1-9 and return the shared journey state.
 *
 * @param ctx - Browser, apps, infrastructure and the step recorder.
 */
export async function setupSteps(ctx: JourneyContext): Promise<World> {
  const { browser, step, skip, shot, findings, target } = ctx;
  const mode = target.mode;
  const runs = (id: StepId) => runsStep(mode, id);
  const runRoot = ctx.launch.runRoot;
  const communityOrigin = mode === 'local' ? target.proof.origin : target.handoff.origin;
  const isolationOrigin = mode === 'local' ? target.isolation.origin : null;
  const signIn =
    mode === 'local'
      ? {
          a: { email: 'desktop-a@example.test', password: PASSWORD },
          b: { email: 'desktop-b@example.test', password: PASSWORD },
        }
      : { a: target.handoff.owner, b: target.handoff.member };
  const stamp = Date.now().toString(36);
  const MSG_A = `Hello from packaged Desktop A ${stamp}`;
  const MSG_B = `Hello from packaged Desktop B ${stamp}`;
  const THREAD_B = `Thread reply from Desktop B ${stamp}`;
  const ATTACH_TEXT = `Attachment note from Desktop A ${stamp}`;
  const ATTACH_NAME = 'proof-attachment.txt';
  const ATTACH_BODY = `two-desktop acceptance payload ${stamp}\n`;
  const ISOLATED_MSG = `Only in Isolation Proof ${stamp}`;

  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const isolationContext = mode === 'local' ? await browser.newContext() : null;
  let owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const isolationOwner = isolationContext ? await isolationContext.newPage() : null;
  // Removing a member and leaving both confirm with a native dialog; a person says yes.
  for (const page of [member, isolationOwner]) page?.on('dialog', (d) => void d.accept());
  Object.assign(ctx.browserPages, { owner, member });
  if (isolationOwner) ctx.browserPages.isolationOwner = isolationOwner;

  async function bootstrap(
    page: Page,
    o: { origin: string; secret: string; person: string; email: string; community: string }
  ) {
    await page.goto(o.origin);
    await page.getByLabel('Setup secret').fill(o.secret);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Your name').fill(o.person);
    await page.getByLabel('Email', { exact: true }).fill(o.email);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Community name').fill(o.community);
    await page.getByLabel('First channel').fill('general');
    await page.getByRole('button', { name: 'Create community', exact: true }).click();
    await expect(page.getByRole('button', { name: 'general', exact: true })).toBeVisible();
  }

  async function createInvite(page: Page): Promise<string> {
    // From the channel view, open Manage; a settings link already shows the form.
    if (!(await page.locator('#invite-channel').isVisible()))
      await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await page.locator('#invite-channel').selectOption({ label: '#general' });
    await page.getByRole('button', { name: 'Create invite', exact: true }).click();
    const link = await page.getByLabel('One-time invite link').inputValue();
    assert(link.startsWith(communityOrigin), 'invite link is on the Community origin');
    return link;
  }

  let communityId: string;
  if (target.mode === 'local') {
    const { proof, isolation } = target;
    await step('1 owner bootstraps the self-hosted Community in a browser', async () => {
      await bootstrap(owner, {
        origin: communityOrigin,
        secret: proof.bootstrapSecret,
        person: 'Desktop A',
        email: signIn.a.email,
        community: COMMUNITY,
      });
      return { screenshot: await shot(owner, '01-owner-bootstrapped') };
    });

    const invite = await step('2 owner creates a one-time invite to #general', async () => {
      const link = await createInvite(owner);
      await shot(owner, '02-owner-invite');
      return link;
    });
    const fromInvite = /\/c\/([0-9a-f-]{36})\/join/.exec(invite)?.[1];
    assert(fromInvite, 'the invite names its community');
    communityId = fromInvite;

    await step('3 member joins via invite → "You’re in …" → Open community', async () => {
      await member.goto(invite);
      await member.getByRole('button', { name: 'Continue', exact: true }).click();
      await member
        .getByRole('button', { name: 'Create an account on this host', exact: true })
        .click();
      await member.getByLabel('Your name').fill('Desktop B');
      await member.getByLabel('Email', { exact: true }).fill(signIn.b.email);
      await member.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await member.getByRole('button', { name: 'Join community', exact: true }).click();
      await expect(member.getByRole('heading', { name: `You’re in ${COMMUNITY}.` })).toBeVisible();
      const confirmation = await shot(member, '03a-member-youre-in');
      await member.getByRole('button', { name: 'Open community', exact: true }).click();
      await expect(member.getByLabel(/Message #general/i)).toBeVisible();
      return { confirmation, opened: await shot(member, '03b-member-open-community') };
    });

    await step(
      '4 a separate Isolation Community is bootstrapped (only Desktop A will join)',
      async () => {
        await bootstrap(isolationOwner!, {
          origin: isolationOrigin!,
          secret: isolation.bootstrapSecret,
          person: 'Desktop A elsewhere',
          email: 'desktop-a-isolation@example.test',
          community: ISOLATION,
        });
      }
    );
  } else {
    communityId = target.handoff.communityId;
    for (const id of ['1', '2', '3', '4'] as const) skip(id);
    // B is already a member; signing B in here is what makes step 7 a
    // signed-in approval. The sign-in page is photographed before anything is typed.
    ctx.receipt.liveOrigin = await step(
      'remote: B signs in on the live community (desktop and phone width)',
      () => signInOnLiveOrigin(ctx, member, communityOrigin, communityId, signIn.b)
    );
  }
  const [a, b] = await step(
    '5 two packaged Desktops boot isolated (own HOME, userData, server)',
    async () => {
      const first = await launchDesktop(ctx.launch, 'person-a');
      ctx.desktops.push(first);
      const second = await launchDesktop(ctx.launch, 'person-b');
      ctx.desktops.push(second);
      assert.notEqual(first.origin, second.origin, 'separate local servers');
      assert.notEqual(first.userData, second.userData);
      return [first, second] as const;
    }
  );
  ctx.receipt.instances = [a, b].map((i) => ({ name: i.name, origin: i.origin }));

  // Signed-out approval: the owner's browser forgets its session first. The old
  // owner tab reacts to losing its session, so the approval opens in a fresh tab.
  await ownerContext.clearCookies();
  await owner.close();
  owner = await ownerContext.newPage();
  owner.on('dialog', (d) => void d.accept());
  ctx.browserPages.owner = owner;
  // A remote run learns the community's name from the connection itself.
  const knownName = mode === 'local' ? COMMUNITY : null;
  const refA = await step(
    '6 Desktop A connects (signed-out approval, owner signs in to approve)',
    () => connectDesktop(a, owner, communityOrigin, knownName, 'Desktop A', signIn.a)
  );
  await shot(a.page, '06-desktop-a-connected');
  const connectionA = (await connections(a)).find((c) => c.ref === refA);
  assert(connectionA, 'A lists its new connection');
  const communityName = connectionA.label;
  if (mode === 'remote')
    assert.equal(
      connectionA.remoteCommunityId,
      communityId,
      'A connected to the handoff’s community'
    );
  const refB = await step('7 Desktop B connects (member approves from signed-in browser)', () =>
    connectDesktop(b, member, communityOrigin, communityName, 'Desktop B', null)
  );
  await shot(b.page, '07-desktop-b-connected');
  let refIso: string | null = null;
  if (runs('8'))
    refIso = await step('8 Desktop A also connects the Isolation Community', () =>
      connectDesktop(a, isolationOwner!, isolationOrigin!, ISOLATION, 'Desktop A', null)
    );
  else skip('8');
  ctx.receipt.refs = { refA, refB, refIso };

  const room = await step(
    '9 both Desktops see the same shared channel through their own connection',
    async () => {
      const roomsA = await json<{ rooms: Room[] }>(`${a.origin}/api/communities/${refA}/rooms`);
      const roomsB = await json<{ rooms: Room[] }>(`${b.origin}/api/communities/${refB}/rooms`);
      const shared =
        target.mode === 'local'
          ? roomsA.rooms.find((x) => x.title.toLowerCase() === 'general')
          : roomsA.rooms.find((x) => x.roomId === target.handoff.channelId);
      assert(shared, 'the shared channel is visible to A');
      assert(
        roomsB.rooms.some((x) => x.roomId === shared.roomId),
        'the same channel is visible to B'
      );
      return shared;
    }
  );
  const channelComposer = (local: Desktop) =>
    composer(local, new RegExp(`Message ${escapeRegExp(room.title)}`));
  const openGeneral = async (local: Desktop, ref: string) => {
    await local.page.goto(`${local.origin}/channels?community=${ref}&id=${room.roomId}`);
    await expect(channelComposer(local)).toBeVisible({ timeout: 30_000 });
  };
  /**
   * Bring the newest messages into view: a reopened channel may land on a
   * remembered row, and the list is virtualized, so older rows are all that render.
   */
  const seeNewest = async (local: Desktop, text: string) => {
    await expect(async () => {
      const down = local.page.getByRole('button', { name: 'Scroll to bottom' });
      if (await down.isVisible()) await down.click();
      await expect(feed(local).getByText(text, { exact: false }).first()).toBeInViewport({
        timeout: 3000,
      });
    }).toPass({ timeout: 45_000 });
  };

  /**
   * Scroll a reader's channel up by hand and wait until the app has remembered
   * that row; returns the remembered row's text.
   */
  async function scrollUpAndRemember(local: Desktop, ref: string, newest: string) {
    const saved = local.page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        /\/api\/community-connections\/navigation\/destination$/.test(new URL(r.url()).pathname) &&
        (r.request().postData() ?? '').includes('scrollAnchorEntryId') &&
        !(r.request().postData() ?? '').includes('"scrollAnchorEntryId":null'),
      { timeout: 30_000 }
    );
    await feed(local).evaluate((el) => {
      let s: HTMLElement | null = el as HTMLElement;
      while (
        s &&
        !(s.scrollHeight > s.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(s).overflowY))
      )
        s = s.parentElement;
      if (!s) throw new Error('no scrolling ancestor');
      s.scrollTop = Math.floor(s.scrollHeight * 0.3);
      s.dispatchEvent(new Event('scroll'));
    });
    const put = await saved;
    const body = JSON.parse(put.request().postData() ?? '{}') as {
      scrollAnchorEntryId?: string;
      destination?: { scrollAnchorEntryId?: string };
    };
    const anchorId = body.scrollAnchorEntryId ?? body.destination?.scrollAnchorEntryId;
    const entries = await json<{ entries: Entry[] }>(
      `${local.origin}/api/communities/${ref}/rooms/${room.roomId}/entries?limit=100`
    );
    const anchorText = entries.entries.find((e) => e.id === anchorId)?.text;
    assert(anchorText && anchorText !== newest, `remembered a mid-history row (${anchorText})`);
    return { anchorText, body };
  }

  const resize = (local: Desktop, width: number, height: number) =>
    local.app.evaluate(
      ({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0]!;
        w.setMinimumSize(320, 500);
        w.setSize(size.width, size.height);
      },
      { width, height }
    );

  const communityRoomIds = [room.roomId];
  const noLocalLookups = async () => {
    const iso = refIso
      ? (await json<{ rooms: Room[] }>(`${a.origin}/api/communities/${refIso}/rooms`)).rooms
      : [];
    const ids = [...communityRoomIds, ...iso.map((r) => r.roomId)];
    const result: Record<string, unknown> = {};
    for (const local of [a, b]) {
      const file = path.join(runRoot, `${local.name}-network.log`);
      const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
      const bad = lines.filter((l) => ids.some((id) => l.includes(`/api/rooms/${id}`)));
      result[local.name] = {
        lines: lines.length,
        localLookupsOfCommunityRooms: bad,
        all404s: lines.filter((l) => / 404$/.test(l)),
      };
      assert.equal(
        bad.length,
        0,
        `${local.name} asked the local rooms route for a community room: ${bad.join(' | ')}`
      );
    }
    return result;
  };

  /**
   * A check of the product's own contract. A failure is recorded as a product
   * bug with its repro and fails the run's outcome, but the journey continues so
   * every later step still reports.
   */
  async function productCheck(check: string, repro: string, verify: () => Promise<void>) {
    try {
      await verify();
      findings.push({ check, kind: 'product-contract', pass: true });
    } catch (error) {
      findings.push({
        check,
        kind: 'product-bug',
        pass: false,
        repro,
        error: (error as Error).message.split('\n')[0],
      });
    }
  }
  return {
    ctx,
    mode,
    runs,
    step,
    skip,
    shot,
    findings,
    a,
    b,
    owner,
    member,
    isolationOwner,
    communityOrigin,
    communityName,
    isolationOrigin,
    communityId,
    refA,
    refB,
    refIso,
    room,
    stamp,
    MSG_A,
    MSG_B,
    THREAD_B,
    ATTACH_TEXT,
    ATTACH_NAME,
    ATTACH_BODY,
    ISOLATED_MSG,
    fillers: [],
    communityRoomIds,
    channelComposer,
    openGeneral,
    seeNewest,
    scrollUpAndRemember,
    resize,
    noLocalLookups,
    createInvite,
    productCheck,
  };
}

/**
 * Sign B in on the live community the way a person would, photographing the
 * sign-in page and the channel view at desktop width (1280 x 860) and at phone
 * width (390 x 844). The sign-in page is shot before anything is typed, so no
 * credential reaches a screenshot.
 *
 * @param ctx - The runner's context, for screenshots.
 * @param member - B's browser page.
 * @param origin - The community's origin.
 * @param communityId - The community B belongs to.
 * @param account - B's account on it.
 */
async function signInOnLiveOrigin(
  ctx: JourneyContext,
  member: Page,
  origin: string,
  communityId: string,
  account: { email: string; password: string }
) {
  const entry = `${origin}/c/${communityId}`;
  const phone = await member.context().newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await member.setViewportSize({ width: 1280, height: 860 });
  const signInButton = (page: Page) => page.getByRole('button', { name: 'Sign in', exact: true });
  const evidence: Record<string, string | boolean> = {};
  for (const [page, width] of [
    [member, 'desktop'],
    [phone, 'phone'],
  ] as const) {
    await page.goto(entry);
    await expect(signInButton(page)).toBeVisible({ timeout: 30_000 });
    evidence[`signIn-${width}`] = await ctx.shot(page, `remote-sign-in-${width}`);
    evidence[`signIn-${width}-overflows`] = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
  }
  await member.getByLabel('Email', { exact: true }).fill(account.email);
  await member.getByLabel('Password', { exact: true }).fill(account.password);
  await signInButton(member).click();
  const channelBox = (page: Page) => page.getByLabel(/^Message #/i).first();
  /** The channel, shown once its messages have loaded. */
  const channelReady = async (page: Page) => {
    await expect(channelBox(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Loading messages…')).toHaveCount(0, { timeout: 30_000 });
  };
  await channelReady(member);
  evidence['channel-desktop'] = await ctx.shot(member, 'remote-channel-desktop');
  // Same browser, same session: the phone-width page opens signed in.
  await phone.goto(entry);
  await channelReady(phone);
  evidence['channel-phone'] = await ctx.shot(phone, 'remote-channel-phone');
  evidence['channel-phone-overflows'] = await phone.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  await phone.close();
  // Nothing sideways at phone width, on either page.
  assert.equal(
    evidence['signIn-phone-overflows'],
    false,
    'the sign-in page scrolls sideways at 390 px'
  );
  assert.equal(
    evidence['channel-phone-overflows'],
    false,
    'the channel view scrolls sideways at 390 px'
  );
  return evidence;
}
