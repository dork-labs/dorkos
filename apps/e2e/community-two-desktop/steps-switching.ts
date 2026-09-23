import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import {
  composer,
  connections,
  destinations,
  escapeRegExp,
  feed,
  json,
  messageRow,
  openSwitcher,
  send,
  sendJson,
  switchTo,
  threadFeed,
  timeline,
  trigger,
} from './desktop.js';
import { COMMUNITY, ISOLATION, type Entry, type Room, type World } from './world.js';

/**
 * Steps 10-19: moving between this DorkOS and the Communities with the
 * switcher, posting, threads, files, reopening where the reader was, isolation
 * between Communities, keyboard and phone width, and no local lookups of
 * Community rooms.
 *
 * @module community-two-desktop/steps-switching
 */

/**
 * Run steps 10-19.
 *
 * @param w - The journey so far.
 */
export async function switchingSteps(w: World): Promise<void> {
  const {
    ctx,
    step,
    shot,
    findings,
    a,
    b,
    refA,
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
    fillers,
    scrollUpAndRemember,
    resize,
    noLocalLookups,
  } = w;
  const refB = w.refB;
  await step(
    '10 switcher (desktop name trigger) moves A and B from this DorkOS into the community',
    async () => {
      const evidence: Record<string, unknown> = {};
      for (const local of [a, b]) {
        await local.page.goto(local.origin + '/');
        await expect(trigger(local)).toBeVisible({ timeout: 60_000 });
        const before = await trigger(local).getAttribute('aria-label');
        await openSwitcher(local);
        await expect(destinations(local).filter({ hasText: COMMUNITY })).toBeVisible();
        if (local === b)
          await expect(
            destinations(local).filter({ hasText: ISOLATION }),
            'B never joined Isolation'
          ).toHaveCount(0);
        await local.page.waitForTimeout(400); // let the menu's open animation settle for a legible shot
        const menu = await shot(local.page, `10-${local.name}-switch-context-menu`);
        await destinations(local).filter({ hasText: COMMUNITY }).click();
        await expect(local.page).toHaveURL(/\/channels\?.*community=/, { timeout: 30_000 });
        await expect(trigger(local)).toHaveAttribute('aria-label', `${COMMUNITY} menu`);
        const landed = await shot(local.page, `10b-${local.name}-after-switch`);
        // First visit has no remembered destination: the switcher falls back to the first readable channel.
        await expect(local.page).toHaveURL(new RegExp(`id=${escapeRegExp(room.roomId)}`), {
          timeout: 30_000,
        });
        await expect(composer(local, /Message general/)).toBeVisible({ timeout: 30_000 });
        // The tab names the channel ("general", drawn with a # glyph), never the generic "Channels".
        const activeTab = local.page
          .getByRole('tablist', { name: 'Open tabs' })
          .getByRole('tab', { selected: true });
        await expect(activeTab).toHaveAccessibleName('general', { timeout: 30_000 });
        await expect(activeTab).not.toContainText('Channels');
        evidence[local.name] = { triggerBefore: before, url: local.page.url(), menu, landed };
      }
      return evidence;
    }
  );

  await step('11 both people post in #general and each sees the other live', async () => {
    for (const [sender, receiver, message] of [
      [a, b, MSG_A],
      [b, a, MSG_B],
    ] as const) {
      await send(composer(sender), message);
      await expect(feed(sender)).toContainText(message, { timeout: 30_000 });
      await expect(feed(receiver)).toContainText(message, { timeout: 30_000 });
    }
    return {
      a: await shot(a.page, '11-desktop-a-general'),
      b: await shot(b.page, '11-desktop-b-general'),
    };
  });

  await step(
    '12 B replies in a thread on A’s message; A opens the thread and sees it',
    async () => {
      await messageRow(feed(b), MSG_A).getByRole('button', { name: 'Reply in thread' }).click();
      await expect(threadFeed(b)).toBeVisible();
      await send(composer(b, /Reply in thread/), THREAD_B);
      await expect(threadFeed(b)).toContainText(THREAD_B, { timeout: 30_000 });
      await expect(feed(a)).not.toContainText(THREAD_B); // replies stay out of the channel
      await messageRow(feed(a), MSG_A)
        .getByRole('button', { name: /Reply in thread|Open thread/ })
        .first()
        .click();
      await expect(threadFeed(a)).toContainText(THREAD_B, { timeout: 30_000 });
      const evidence = {
        a: await shot(a.page, '12-desktop-a-thread'),
        b: await shot(b.page, '12-desktop-b-thread'),
      };
      for (const local of [a, b]) {
        await local.page.getByRole('button', { name: 'Back to channel', exact: true }).click();
        await expect(feed(local)).toBeVisible();
      }
      return evidence;
    }
  );

  await step(
    '13 A attaches a file; B sees it and its bytes arrive intact through B’s connection',
    async () => {
      const file = path.join(ctx.launch.runRoot, ATTACH_NAME);
      writeFileSync(file, ATTACH_BODY);
      const chooser = a.page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null);
      await a.page.getByRole('button', { name: 'Attach file' }).first().click();
      const fileChooser = await chooser;
      if (fileChooser) await fileChooser.setFiles(file);
      else await a.page.locator('input[type="file"]').first().setInputFiles(file);
      await send(composer(a), ATTACH_TEXT);
      await expect(feed(b)).toContainText(ATTACH_TEXT, { timeout: 60_000 });
      await expect(feed(b).getByRole('button', { name: ATTACH_NAME, exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const entries = await json<{ entries: Entry[] }>(
        `${b.origin}/api/communities/${refB}/rooms/${room.roomId}/entries`
      );
      const entry = entries.entries.find((e) => e.text === ATTACH_TEXT);
      assert(entry && entry.attachments.length === 1 && entry.attachments[0]!.name === ATTACH_NAME);
      const bytes = await fetch(
        `${b.origin}/api/communities/${refB}/rooms/${room.roomId}/attachments/${entry.attachments[0]!.id}`
      );
      assert(bytes.ok, `B attachment download ${bytes.status}`);
      assert.equal(await bytes.text(), ATTACH_BODY, 'attachment bytes intact');
      return {
        b: await shot(b.page, '13-desktop-b-attachment'),
        attachmentId: entry.attachments[0]!.id,
      };
    }
  );

  await step(
    '14 A switches to this DorkOS: no community content leaks into the local install',
    async () => {
      await switchTo(a, 0);
      await expect(a.page).not.toHaveURL(/community=/);
      await expect(feed(a)).toHaveCount(0);
      const body = await a.page.locator('body').innerText();
      for (const text of [MSG_A, MSG_B, THREAD_B, ATTACH_TEXT])
        assert(!body.includes(text), `local view shows ${text}`);
      const localRooms = JSON.stringify(await json(`${a.origin}/api/rooms`));
      for (const text of [MSG_A, MSG_B, COMMUNITY])
        assert(!localRooms.includes(text), `local rooms mention ${text}`);
      const search = await fetch(`${a.origin}/api/search?q=${encodeURIComponent(stamp)}`);
      const searchBody = search.ok ? await search.text() : `HTTP ${search.status}`;
      if (search.ok)
        assert(!searchBody.includes(stamp), 'local message search indexes community text');
      return {
        screenshot: await shot(a.page, '14-desktop-a-this-dorkos'),
        url: a.page.url(),
        search: search.ok ? 'no hits' : searchBody,
      };
    }
  );

  await step(
    '15 A switches back to the community and reopens #general at its last-read position',
    async () => {
      await switchTo(a, COMMUNITY);
      await expect(a.page).toHaveURL(
        new RegExp(
          `community=${escapeRegExp(refA)}.*id=${escapeRegExp(room.roomId)}|id=${escapeRegExp(room.roomId)}.*community=${escapeRegExp(refA)}`
        )
      );
      await expect(feed(a)).toBeVisible();
      await expect(feed(a)).toContainText(MSG_B);
      await expect
        .poll(() => timeline(a).getAttribute('data-landed-on'), { timeout: 15_000 })
        .not.toBeNull();
      const landedOn = await timeline(a).getAttribute('data-landed-on');
      return {
        landedOn,
        url: a.page.url(),
        screenshot: await shot(a.page, '15-desktop-a-reopened'),
      };
    }
  );

  await step(
    '15b a reader scrolled up reopens at that row (remembered), not at the newest',
    async () => {
      // B adds history through B's own Desktop server, so A's channel is long enough to scroll.
      for (let i = 1; i <= 40; i++) {
        const text = `History filler ${String(i).padStart(2, '0')} ${stamp}`;
        fillers.push(text);
        await json(
          `${b.origin}/api/communities/${refB}/rooms/${room.roomId}/entries`,
          sendJson('POST', { text, idempotencyKey: randomUUID() })
        );
      }
      // Incoming history does not move a reader (the timeline offers "New messages"
      // instead), and the list is virtualized, so jump to the newest before reading it.
      await expect
        .poll(
          async () =>
            JSON.stringify(
              await json(
                `${a.origin}/api/communities/${refA}/rooms/${room.roomId}/entries?limit=100`
              )
            ).includes(fillers.at(-1)!),
          { timeout: 60_000 }
        )
        .toBe(true);
      const arrival = await shot(a.page, '15b-0-desktop-a-new-messages-arrive');
      let bottomClicks = 0;
      await expect(async () => {
        const down = a.page.getByRole('button', { name: 'Scroll to bottom' });
        if (await down.isVisible()) {
          await down.click();
          bottomClicks++;
        }
        await expect(feed(a).getByText(fillers.at(-1)!, { exact: true })).toBeInViewport({
          timeout: 3000,
        });
      }).toPass({ timeout: 45_000 });
      findings.push({
        check: 'One "Scroll to bottom" press reaches the newest message after a burst',
        bottomClicks,
        pass: bottomClicks <= 1,
      });
      const { anchorText, body } = await scrollUpAndRemember(a, refA, fillers.at(-1)!);
      const scrolled = await shot(a.page, '15b-1-desktop-a-scrolled-up');
      await switchTo(a, 0);
      await expect(a.page).not.toHaveURL(/community=/);
      await switchTo(a, COMMUNITY);
      await expect(timeline(a)).toHaveAttribute('data-landed-on', 'remembered', {
        timeout: 30_000,
      });
      await expect(feed(a).getByText(anchorText, { exact: true })).toBeInViewport();
      await expect(feed(a).getByText(fillers.at(-1)!, { exact: true })).not.toBeInViewport();
      return {
        anchorText,
        body,
        arrival,
        scrolled,
        reopened: await shot(a.page, '15b-2-desktop-a-reopened-at-remembered-row'),
      };
    }
  );

  await step(
    '16 A switches to Isolation Proof, posts there; nothing crosses to Desktop Proof or B',
    async () => {
      await switchTo(a, ISOLATION);
      await expect(a.page).toHaveURL(new RegExp(`community=${escapeRegExp(refIso)}`), {
        timeout: 30_000,
      });
      await expect(trigger(a)).toHaveAttribute('aria-label', `${ISOLATION} menu`);
      const isoRooms = await json<{ rooms: Room[] }>(`${a.origin}/api/communities/${refIso}/rooms`);
      const isoGeneral = isoRooms.rooms.find((x) => x.title.toLowerCase() === 'general');
      assert(
        isoGeneral && isoGeneral.roomId !== room.roomId,
        'isolation general is a different room'
      );
      if (!a.page.url().includes(`id=${encodeURIComponent(isoGeneral.roomId)}`))
        await a.page.goto(`${a.origin}/channels?community=${refIso}&id=${isoGeneral.roomId}`);
      await expect(composer(a, /Message general/)).toBeVisible({ timeout: 30_000 });
      await expect(a.page.getByText('No messages here yet.')).toBeVisible({ timeout: 30_000 });
      for (const text of [MSG_A, MSG_B, ATTACH_TEXT])
        await expect(a.page.locator('main, body').first()).not.toContainText(text);
      await send(composer(a), ISOLATED_MSG);
      await expect(feed(a)).toContainText(ISOLATED_MSG, { timeout: 30_000 });
      const isoShot = await shot(a.page, '16a-desktop-a-isolation');
      await switchTo(a, COMMUNITY);
      await expect(feed(a)).toBeVisible();
      // Back on the remembered mid-history row (15b), so read what is rendered there.
      await expect(feed(a)).toContainText(new RegExp(`History filler \\d\\d ${stamp}`));
      await expect(feed(a)).not.toContainText(ISOLATED_MSG);
      await expect(feed(b)).not.toContainText(ISOLATED_MSG);
      const bEntries = JSON.stringify(
        await json(`${b.origin}/api/communities/${refB}/rooms/${room.roomId}/entries`)
      );
      const aEntries = JSON.stringify(
        await json(`${a.origin}/api/communities/${refA}/rooms/${room.roomId}/entries`)
      );
      assert(
        !bEntries.includes(ISOLATED_MSG) && !aEntries.includes(ISOLATED_MSG),
        'isolation text leaked'
      );
      assert.equal((await connections(b)).length, 1, 'B holds only its own connection');
      const foreign = await fetch(`${b.origin}/api/communities/${refIso}/rooms`);
      assert(!foreign.ok, `B can read A's isolation ref (${foreign.status})`);
      return {
        isoShot,
        backShot: await shot(a.page, '16b-desktop-a-back-in-proof'),
        foreignStatus: foreign.status,
      };
    }
  );

  await step('17 keyboard: ⌘⇧K opens the switcher on A, arrows + Enter move context', async () => {
    await trigger(a).focus();
    await a.page.keyboard.press('Meta+Shift+K');
    await expect(a.page.getByText('Switch context', { exact: true })).toBeVisible();
    const items = a.page.getByRole('menuitemradio');
    await expect(items.first()).toBeVisible();
    const focusedName = () =>
      a.page.evaluate(() => {
        const el = document.activeElement;
        return el
          ? `${el.getAttribute('role') ?? el.tagName}: ${(el.textContent ?? '').trim().slice(0, 40)}`
          : null;
      });
    await a.page.waitForTimeout(500);
    const keyboardOpenFocus = await focusedName();
    const kbShot = await shot(a.page, '17-desktop-a-keyboard-menu');
    await a.page.keyboard.press('Escape');
    await expect(a.page.getByText('Switch context', { exact: true })).toBeHidden();
    const escapeRestored = await trigger(a).evaluate((el) => el === document.activeElement);
    await trigger(a).click();
    await a.page.waitForTimeout(500);
    const pointerOpenFocus = await focusedName();
    await a.page.keyboard.press('Escape');
    // Spec (community-switcher-navigation §Desktop): "Opening focuses the selected row."
    assert.match(
      keyboardOpenFocus ?? '',
      /^menuitemradio: Desktop Proof/,
      `⌘⇧K focused ${keyboardOpenFocus}`
    );
    assert.match(
      pointerOpenFocus ?? '',
      /^menuitemradio: Desktop Proof/,
      `click focused ${pointerOpenFocus}`
    );
    assert.equal(escapeRestored, true, 'Escape restores focus to the trigger');
    findings.push({
      check: 'Opening the switcher focuses the selected row (Desktop Proof)',
      keyboardOpenFocus,
      pointerOpenFocus,
      escapeRestoredFocusToTrigger: escapeRestored,
      pass: true,
    });
    await trigger(a).focus();
    await a.page.keyboard.press('Meta+Shift+K');
    await expect(a.page.getByText('Switch context', { exact: true })).toBeVisible();
    await a.page.keyboard.press('Home');
    await expect(items.first()).toBeFocused();
    await a.page.keyboard.press('Enter');
    await expect(a.page).not.toHaveURL(/community=/, { timeout: 30_000 });
    return { kbShot };
  });

  await step(
    '18 phone width: B’s icon trigger opens the context sheet and switches into the community',
    async () => {
      await resize(b, 390, 844);
      await expect
        .poll(() => b.page.evaluate(() => window.innerWidth), { timeout: 15_000 })
        .toBeLessThan(500);
      await b.page.goto(b.origin + '/');
      const phoneTrigger = trigger(b).filter({ visible: true }).first();
      await expect(phoneTrigger).toBeVisible({ timeout: 60_000 });
      // Icon, not a name: the visible text is empty; the accessible name carries it.
      const visibleText = (await phoneTrigger.innerText()).trim();
      const label = await phoneTrigger.getAttribute('aria-label');
      await phoneTrigger.click();
      const radio = b.page
        .getByRole('radio')
        .or(b.page.getByRole('menuitemradio'))
        .filter({ hasText: COMMUNITY });
      await expect(radio).toBeVisible();
      await b.page.waitForTimeout(600); // let the sheet finish sliding up
      const sheet = await shot(b.page, '18a-desktop-b-phone-sheet');
      const overflow = await b.page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      await radio.click();
      await expect(b.page).toHaveURL(/community=/, { timeout: 30_000 });
      // B may reopen at a remembered row (the list is virtualized): look for this run's messages.
      await expect(feed(b)).toContainText(stamp, { timeout: 30_000 });
      await expect(feed(b)).not.toContainText(ISOLATED_MSG);
      const phoneLanded = await timeline(b).getAttribute('data-landed-on');
      const phoneRoom = await shot(b.page, '18b-desktop-b-phone-community');
      return { visibleText, label, overflow, sheet, phoneRoom, phoneLanded };
    }
  );

  await step(
    '19 no local /api/rooms lookup of a community room id (no 404s) in either app',
    noLocalLookups
  );
}
