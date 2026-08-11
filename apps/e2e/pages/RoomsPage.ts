import type { Page, Locator } from '@playwright/test';
import { NewMenuPage } from './NewMenuPage';

/**
 * The text a sighted reader actually sees inside `element`.
 *
 * `textContent` and `innerText` both answer with screen-reader-only text: the
 * `sr-only` utility keeps its element in flow at 1×1px and merely clips it, and
 * neither property can see a clip. That matters here because a room carries its
 * name twice on purpose — `#general` for a screen reader, the bare `general`
 * beside the `#` mark for everyone else — so "what is on screen" and "what is
 * announced" are different strings and each has its own defect to catch
 * (spec `rooms` §13.1).
 *
 * Text nodes whose element is clipped to a pixel are dropped; everything left is
 * joined by a space, which is how a browser lays out inline siblings anyway.
 *
 * @param element - The element to read.
 * @returns The visible text, whitespace-collapsed.
 */
export async function visibleText(element: Locator): Promise<string> {
  return element.evaluate((root) => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const owner = node.parentElement;
      if (!owner) continue;
      const box = owner.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
    return parts.join(' ');
  });
}

/**
 * Page Object for rooms — the sidebar's Channels and Direct messages sections,
 * and the `/channels` room view they open.
 *
 * Rooms carry no `data-testid` on their sidebar rows, so a row is found by the
 * one stable, unique thing it holds: the `title` attribute `RoomTitle` writes,
 * which is the room's spoken name (`#general`, or a DM's title). Locating by
 * rendered text would be wrong twice over — the visible run of a channel row is
 * the bare `general`, and the row's text also contains its unread count.
 */
export class RoomsPage {
  readonly page: Page;

  /** The sidebar's "Channels" group: header, "+" action, and every channel row. */
  readonly channels: Locator;

  /** The sidebar's "Direct messages" group. */
  readonly directMessages: Locator;

  /** The open room's masthead — mark, name, topic and member list. */
  readonly roomHeader: Locator;

  /** The open room's name, as the heading a screen reader reaches for. */
  readonly roomHeading: Locator;

  /** The scrolling element that holds the open room's history. */
  readonly scroller: Locator;

  /**
   * Every `post` in the open room's TIMELINE, oldest first.
   *
   * Scoped to the timeline rather than to the page, and that scope is load-
   * bearing now that a thread has a panel: the panel draws its root and every
   * reply as ordinary {@link RoomEntryRow}s — deliberately, a thread is a
   * different place and not a different kind of message — so a page-wide match
   * counts the same conversation twice. "How many messages are in the room" is
   * a question about the room, and the panel is beside it.
   */
  readonly entries: Locator;

  /** Every `notice` — the room speaking about itself — in the open room. */
  readonly notices: Locator;

  /** The line under the composer naming whoever is working on the room. */
  readonly presenceLine: Locator;

  /**
   * The live region a screen reader hears the presence line through.
   *
   * Separate from {@link RoomsPage.presenceLine} and always in the page, which
   * is the point of it: a live region that arrives with its text already in it
   * is the case assistive technology does not announce.
   */
  readonly presenceAnnouncer: Locator;

  /** The line the room shows once its live stream has given up. */
  readonly stalledNotice: Locator;

  /** Ask a stalled room to reconnect. */
  readonly reconnectButton: Locator;

  /**
   * The one create surface (BC-45). A channel and a direct message are both
   * made here now; the section `+` beside each is a deep link into it rather
   * than a handler of its own.
   */
  readonly newMenu: NewMenuPage;

  constructor(page: Page) {
    this.page = page;
    this.newMenu = new NewMenuPage(page);
    this.channels = this.section('channels');
    this.directMessages = this.section('dms');
    this.roomHeader = page
      .locator('header')
      .filter({ has: page.locator('[data-slot="room-title"]') });
    this.roomHeading = this.roomHeader.getByRole('heading');
    this.scroller = page.locator('[data-testid="room-timeline"]').locator('xpath=..');
    this.entries = page.getByTestId('room-timeline').getByTestId('room-entry');
    this.notices = page.getByTestId('room-notice');
    this.presenceLine = page.getByTestId('room-presence');
    this.presenceAnnouncer = page.getByTestId('room-presence-announcer');
    // The visible banner. Its sentence also lives in a screen-reader-only
    // announcer twin (`room-stalled-announcer`), so matching by text resolves
    // to two elements — target the banner's own testid.
    this.stalledNotice = page.getByTestId('room-stalled');
    this.reconnectButton = page.getByRole('button', { name: 'Reconnect' });
  }

  /**
   * One sidebar section, found by the model id it stamps on itself.
   *
   * @param id - The section's `SidebarSectionModel['id']` — `'channels'`,
   *   `'dms'`, `'agents'`, `'pins'`, or a `group:<id>`.
   */
  section(id: string): Locator {
    // Matched on the section's own model id rather than on its header's
    // accessible name. The name is chrome and moves with it — the redesign made
    // the whole header row the toggle, which put the rollup and the section's
    // adornments inside the button and stopped an exact-match filter resolving
    // at all. The id is what the section IS.
    return this.page.locator(`[data-sidebar-section="${id}"]`);
  }

  /**
   * One room's sidebar row, in the Channels or Direct messages section.
   *
   * Scoped to the two room sections rather than the whole sidebar because a
   * room with activity also appears in "Jump back in" above them (team-room-home
   * P1) — an unscoped match resolves to two elements and trips strict mode.
   *
   * @param spokenName - The room's spoken name: `#slug` for a channel, the title
   *   for a direct message.
   */
  row(spokenName: string): Locator {
    return this.rowIn(this.channels.or(this.directMessages), spokenName);
  }

  /**
   * One room's row, required to be in a particular section — so a channel
   * appearing under Direct messages fails rather than passing quietly.
   *
   * @param section - {@link RoomsPage.channels} or {@link RoomsPage.directMessages}.
   * @param spokenName - The room's spoken name.
   */
  rowIn(section: Locator, spokenName: string): Locator {
    // Descendant, not direct child. The row's button used to be an immediate
    // child of the menu item; DOR-572 wrapped it in a context-menu trigger
    // (`SidebarMenuItem > div > button`), and the `>` combinator kept here
    // silently stopped matching any room at all. The `has` filter is what makes
    // the row unique — the only other button in the item is its "… actions"
    // trigger, which holds no room title — so the looser combinator costs
    // nothing and stops one more wrapper from doing this again.
    return section
      .locator('[data-slot="sidebar-menu-item"] button')
      .filter({ has: this.page.locator(`[data-slot="room-title"][title="${spokenName}"]`) });
  }

  /**
   * The mark drawn beside a room's name in the sidebar — a `#` for a channel,
   * the agent's own face for a direct message.
   *
   * @param spokenName - The room's spoken name.
   */
  rowMark(spokenName: string): Locator {
    return this.row(spokenName).locator('[data-slot="room-avatar"]');
  }

  /**
   * The dot on a sidebar row that says an agent is working in that room.
   *
   * Found by its accessible name, which is also what it is FOR: a dot with no
   * text is only useful to a reader who can see it, so the count lives in the
   * label. Matching on the label is therefore the same assertion as matching on
   * the pixel, and one a screen-reader user shares.
   *
   * @param spokenName - The room's spoken name.
   */
  rowWorkingDot(spokenName: string): Locator {
    return this.row(spokenName).getByRole('img', { name: /agents? working$/ });
  }

  /** The mark drawn beside the open room's name in its masthead. */
  get headerMark(): Locator {
    return this.roomHeader.locator('[data-slot="room-avatar"]');
  }

  /**
   * The open bridged channel's visibility badge in the masthead — "sees
   * mentions only" or "sees everything", read off the bridge row's platform-
   * sourced privacy mode (chats-as-channels §8). Absent on a DM and on any
   * unbridged room, so its presence is itself the assertion that this is a
   * bridged channel.
   */
  get visibilityBadge(): Locator {
    return this.page.getByTestId('bridge-visibility-badge');
  }

  /**
   * Every external-origin mark on the open room — the "· Telegram" glyph and
   * label drawn beside a message (or roster row) from someone outside this
   * machine (chats-as-channels §4.3). A message from a local author has none.
   */
  get originMarks(): Locator {
    return this.page.getByTestId('origin-mark');
  }

  /** Everyone on the open room's roster, as the masthead draws them. */
  get memberList(): Locator {
    return this.page.locator('[data-slot="room-member-list"]');
  }

  /**
   * Create a channel the way a person does: the "+" beside Channels, a name,
   * the agents that are to be in it, then Create. The cockpit opens the new
   * channel on success.
   *
   * Naming it and filling it are one step (spec `rooms` §14.2), and the whole
   * thing is ONE request — so a caller that names agents can assert the roster
   * straight after this returns rather than waiting on follow-up writes.
   *
   * @param name - The channel's name. The server derives its `#slug` from this.
   * @param agents - Display names to put in it, as the picker lists them. Empty
   *   takes the deliberate "Create it without agents" path.
   */
  async createChannel(name: string, agents: string[] = []): Promise<void> {
    // Two steps, because the Channels "+" no longer runs a handler of its own:
    // it deep-links into the one New menu with "Channel" picked out (BC-45).
    // Going through the "+" rather than the New button is deliberate — it is
    // the only path that proves the deep link still leads somewhere.
    await this.newMenu.chooseFromSectionPlus('New channel', 'new-channel');
    const dialog = this.page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('textbox', { name: 'Channel name' }).fill(name);

    for (const agent of agents) {
      await this.agentSearch.fill(agent);
      await this.page.getByRole('option', { name: agent, exact: true }).click();
    }

    await dialog
      .getByRole('button', {
        name: agents.length === 0 ? 'Create it without agents' : /^Create channel with /,
      })
      .click();
  }

  /** The open room's roster in the masthead, which opens the members panel. */
  get membersButton(): Locator {
    return this.page.getByRole('button', { name: /^Members of / });
  }

  /** The empty state's own affordance for putting agents in the room. */
  get emptyStateAddAgents(): Locator {
    return this.page.getByRole('button', { name: /^Add (more )?agents$/ });
  }

  /**
   * Open the direct-message picker, from whichever door this install has.
   *
   * Both doors land in the same place now (BC-45). The Direct messages section
   * carries a `+`, and BC-32 withholds that section entirely until a
   * conversation exists — so on a fresh install the way in is the New button
   * itself, which is always there. Preferring the `+` when it exists keeps the
   * deep link under test; falling back to the New button is what stops "this
   * operator has no conversations yet" becoming a timeout.
   */
  async openDirectMessagePicker(): Promise<void> {
    const sectionPlus = this.newMenu.sectionPlus('New direct message');
    if ((await sectionPlus.count()) > 0) {
      await this.newMenu.chooseFromSectionPlus('New direct message', 'new-message');
    } else {
      await this.newMenu.choose('new-message');
    }
    await this.agentSearch.waitFor({ state: 'visible' });
  }

  /** The direct-message picker's typeahead field. */
  get agentSearch(): Locator {
    return this.page.getByRole('combobox', { name: 'Search agents' });
  }

  /** The picker's list of agents still available to add. */
  get agentOptions(): Locator {
    return this.page.getByRole('listbox', { name: 'Agents' }).getByRole('option');
  }

  /** The picker's action, whose label says whether it will open a group. */
  get startConversationButton(): Locator {
    return this.page.getByRole('button', { name: /^Start (group )?conversation$/ });
  }

  /**
   * Add one agent to the conversation being assembled, by typing enough of its
   * name and taking the highlighted match with Enter.
   *
   * @param name - The agent's display name.
   */
  async chooseAgent(name: string): Promise<void> {
    await this.agentSearch.fill(name);
    await this.page.getByRole('option', { name, exact: true }).click();
  }

  /** The chip standing for an agent already in the conversation being assembled. */
  agentChip(name: string): Locator {
    return this.page.getByRole('button', { name: `Remove ${name}` });
  }

  /**
   * The open room's composer.
   *
   * @param spokenName - The room's spoken name, which the placeholder is built
   *   from ("Message #general…").
   */
  composer(spokenName: string): Locator {
    return this.page.getByRole('combobox', { name: `Message ${spokenName}…` });
  }

  /**
   * Say something in the open room, the way a person does.
   *
   * @param spokenName - The room's spoken name.
   * @param text - What to say.
   */
  async post(spokenName: string, text: string): Promise<void> {
    const composer = this.composer(spokenName);
    await composer.fill(text);
    await composer.press('Enter');
  }

  /**
   * The card one composer lives in — the chrome that holds the chip bar, the
   * paperclip and the text box.
   *
   * Found by the box inside it rather than by position, because a room showing a
   * thread has TWO composer cards on screen and they are otherwise identical.
   * The box's accessible name is the only thing that says which conversation a
   * card writes into, which is exactly the claim a test scoping to one is making.
   *
   * @param spokenName - The room's spoken name.
   */
  composerCard(spokenName: string): Locator {
    return this.page.locator('[data-composer-card]').filter({ has: this.composer(spokenName) });
  }

  /**
   * Attach files to the open room's composer.
   *
   * Drives the paperclip's own hidden `<input type="file">` rather than the
   * card's, and the distinction is load-bearing: `Composer.Root` renders a
   * SECOND file input for react-dropzone, so a bare `input[type=file]` inside
   * the card resolves to two elements and fails strict mode. This one is
   * located as the input immediately before the "Attach file" button, which is
   * the relationship the markup actually guarantees.
   *
   * `setInputFiles` is the honest gesture for a file picker: the picker itself
   * is the operating system's, so the click that opens it is the one part of
   * this flow no browser test can drive. Everything downstream — the chips, the
   * upload, the send — is the product's.
   *
   * @param spokenName - The room's spoken name.
   * @param filePaths - Absolute paths to the files to attach.
   */
  async attach(spokenName: string, filePaths: string[]): Promise<void> {
    await this.composerCard(spokenName)
      .getByRole('button', { name: 'Attach file' })
      .locator('xpath=preceding-sibling::input[@type="file"][1]')
      .setInputFiles(filePaths);
  }

  /**
   * The chips above the box — the files waiting to be sent with the next message.
   *
   * Found by each chip's own remove button, which carries the filename in its
   * accessible name. The chip's visible text truncates a long name to fit, so
   * the label is both the more stable string and the one a screen reader hears.
   *
   * @param spokenName - The room's spoken name.
   */
  composerChips(spokenName: string): Locator {
    return this.composerCard(spokenName).getByRole('button', {
      name: /^(Remove|Cancel upload of) /,
    });
  }

  /**
   * One chip on the composer's bar, by the file it stands for.
   *
   * @param spokenName - The room's spoken name.
   * @param fileName - The file's name, as the picker handed it over.
   */
  composerChip(spokenName: string, fileName: string): Locator {
    return this.composerCard(spokenName).getByRole('button', {
      name: `Remove ${fileName}`,
      exact: true,
    });
  }

  /**
   * The files hanging under one message.
   *
   * Absent entirely on a message posted without any — the block renders nothing
   * rather than an empty rail — so `toHaveCount(0)` is the honest assertion for
   * a message that carried no files.
   *
   * @param entry - The message row, from {@link RoomsPage.entries}.
   */
  attachmentsIn(entry: Locator): Locator {
    return entry.getByTestId('room-entry-attachments');
  }

  /**
   * The thumbnail drawn for one attachment, by the file it shows.
   *
   * An `<img>` is only ever drawn where the SERVER sniffed the bytes and found
   * an image, so asking for one by name is asking whether the round trip
   * preserved that verdict — not merely whether something rendered.
   *
   * @param entry - The message row.
   * @param fileName - The file's name, which is the image's alt text.
   */
  attachmentImage(entry: Locator, fileName: string): Locator {
    return this.attachmentsIn(entry).getByRole('img', { name: fileName, exact: true });
  }

  /**
   * The download chip drawn for one attachment, by the file it names.
   *
   * The other half of the same verdict: everything the server did not verify as
   * an image is a link and never an `<img>`.
   *
   * @param entry - The message row.
   * @param fileName - The file's name, as the chip prints it.
   */
  attachmentChip(entry: Locator, fileName: string): Locator {
    return this.attachmentsIn(entry)
      .getByTestId('room-entry-attachment-chip')
      .filter({ hasText: fileName });
  }

  /**
   * One entry in the open room, found by what it says.
   *
   * @param text - The entry's exact body text.
   */
  entry(text: string): Locator {
    return this.entries.filter({ has: this.page.getByText(text, { exact: true }) });
  }

  /**
   * The action toolbar drawn over one message.
   *
   * Always in the page — it is revealed by opacity, not by mounting — so
   * `toBeVisible` cannot answer whether it is showing. Assert `opacity` for
   * that; Playwright's visibility check does not read it.
   *
   * @param entry - The message row, from {@link RoomsPage.entries}.
   */
  actionsIn(entry: Locator): Locator {
    return entry.getByTestId('entry-actions');
  }

  /**
   * The quick-reaction buttons in one message's capsule, in the order drawn.
   *
   * **Never assert WHICH emoji these are.** The quick row is the reader's own
   * most-used, counted across every room on the server — so a sibling spec that
   * reacts changes what this row holds, and a test naming 👍 is making a claim
   * only one test in the suite can be right about (see `GOTCHAS.md`). Read the
   * row, then assert against what you read.
   *
   * @param entry - The message row, from {@link RoomsPage.entries}.
   */
  quickReactionsIn(entry: Locator): Locator {
    return this.actionsIn(entry).locator('[data-entry-action="react"]');
  }

  /**
   * The pill row under one message.
   *
   * Absent entirely on a message nobody has reacted to — the design's "zero
   * reactions stay perfectly clean" is a promise about the DOM, not about
   * opacity, so `toHaveCount(0)` is the honest assertion for it.
   *
   * @param entry - The message row, from {@link RoomsPage.entries}.
   */
  reactionsIn(entry: Locator): Locator {
    return entry.getByTestId('entry-reactions');
  }

  /**
   * One pill under a message, found by the emoji on it.
   *
   * @param entry - The message row.
   * @param emoji - The reaction to look for.
   */
  reaction(entry: Locator, emoji: string): Locator {
    return entry.locator(`[data-testid="entry-reaction"][data-emoji="${emoji}"]`);
  }

  /** The faint 🙂+ that ends a row which already has reactions on it. */
  reactionAdd(entry: Locator): Locator {
    return entry.getByTestId('entry-reactions-add');
  }

  /** The searchable emoji grid, wherever it was opened from. */
  get reactionPicker(): Locator {
    return this.page.getByTestId('reaction-picker');
  }

  /**
   * The one quiet line under a thread's root: "↳ 3 replies · last 9:45 AM".
   *
   * Positional on purpose, and this is the same rigour the retired
   * `threadUnder` carried for the retired inline gathering. A thread is a
   * relation between entries rather than a room with an id of its own
   * (ADR 260728-022013), so "the replies to THIS message" is a question about
   * where the row sits — matching it by position is what catches a row that
   * renders against the wrong root, which a page-wide `getByTestId` would pass.
   *
   * @param entry - The message the thread hangs off.
   */
  replyRow(entry: Locator): Locator {
    return entry.locator('xpath=following-sibling::*[1][@data-testid="room-thread-replies"]');
  }

  /** Every reply row in the open room — how many threads it is showing. */
  get replyRows(): Locator {
    return this.page.getByTestId('room-thread-replies');
  }

  /**
   * The number inside one reply row.
   *
   * Read separately from the row's whole sentence because the row also says
   * when the last reply landed, which is a clock — asserting the count against
   * the row's text would mean matching a timestamp that changes every run.
   *
   * @param entry - The message the thread hangs off.
   */
  replyCount(entry: Locator): Locator {
    return this.replyRow(entry).getByTestId('room-thread-reply-count');
  }

  /**
   * The thread panel: the column beside the room, or the whole screen on a phone.
   *
   * One locator for both shapes deliberately. It is the same `section` in both
   * — the design's "two shapes, one panel" — so a test that had to pick a
   * locator per viewport would be asserting our layout classes rather than the
   * thing a reader sees.
   */
  get threadPanel(): Locator {
    return this.page.getByTestId('room-thread-panel');
  }

  /** The messages drawn inside the open panel: the root, then its replies. */
  get threadEntries(): Locator {
    return this.threadPanel.getByTestId('room-entry');
  }

  /**
   * The vertical rules the panel hangs its replies off — one per reply.
   *
   * Counted rather than looked at: the connector is `aria-hidden` decoration, so
   * the only honest question to ask it is whether the panel drew one for every
   * reply and none for the root.
   */
  get threadConnectors(): Locator {
    return this.threadPanel.getByTestId('room-thread-connector');
  }

  /** The line the panel shows when the message a thread hangs off is not loaded. */
  get threadOrphan(): Locator {
    return this.page.getByTestId('room-thread-orphan');
  }

  /**
   * The panel's way out on a wide screen.
   *
   * Named rather than found by icon, and it is a different name on a phone
   * ({@link RoomsPage.backToRoom}) — which is the point of asking for it by
   * accessible name at all: the two shapes really do promise different things,
   * and a locator that matched both would let the phone ship an X.
   */
  get closeThread(): Locator {
    return this.page.getByRole('button', { name: 'Close thread' });
  }

  /**
   * The push's way back, which names the room it returns to.
   *
   * @param spokenName - The room's spoken name, as the label is built from it.
   */
  backToRoom(spokenName: string): Locator {
    return this.page.getByRole('button', { name: `Back to ${spokenName}` });
  }

  /**
   * The panel's own composer.
   *
   * Its own locator rather than {@link RoomsPage.composer}, because the
   * placeholder — which IS the accessible name — is what says where the words
   * are going. The room's composer no longer has a thread aim at all: writing
   * into a thread means writing in the panel, so "which composer is this"
   * became a question about which one is on screen, and the accessibility tree
   * is where that is answerable rather than a class only a screenshot sees.
   */
  get threadComposer(): Locator {
    return this.page.getByRole('combobox', { name: 'Reply in this thread…' });
  }

  /**
   * Say something in the open thread, the way a person does.
   *
   * @param text - What to say.
   */
  async replyInThread(text: string): Promise<void> {
    await this.threadComposer.fill(text);
    await this.threadComposer.press('Enter');
  }

  /**
   * Open one message's thread through its hover capsule.
   *
   * The capsule is revealed by hover, so the hover is part of the gesture and
   * not a detail a caller should have to remember.
   *
   * @param entry - The message to reply to.
   */
  async replyInThreadFrom(entry: Locator): Promise<void> {
    await entry.hover();
    await this.actionsIn(entry).getByRole('button', { name: 'Reply in thread' }).click();
  }

  /**
   * Hold a message down long enough for the touch menu, without moving.
   *
   * The gesture is genuinely time-based — the hook waits 500ms and stands down
   * if the pointer travels — so this waits rather than polls.
   *
   * @param entry - The message to press.
   * @param options.holdMs - How long to hold. Below 500 the press is a tap.
   * @param options.driftPx - How far to drag mid-hold, for the scroll case.
   */
  async longPress(
    entry: Locator,
    options: { holdMs?: number; driftPx?: number } = {}
  ): Promise<void> {
    const { holdMs = 700, driftPx = 0 } = options;
    const box = await entry.boundingBox();
    if (!box) throw new Error('Cannot press a message that has no box on screen');
    const x = box.x + Math.min(40, box.width / 2);
    const y = box.y + Math.min(12, box.height / 2);

    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    if (driftPx > 0) await this.page.mouse.move(x, y + driftPx);
    await this.page.waitForTimeout(holdMs);
    await this.page.mouse.up();
  }

  /** How far the room's history is scrolled, in pixels from the top. */
  async scrollTop(): Promise<number> {
    return this.scroller.evaluate((el) => el.scrollTop);
  }

  /** Whether the history is scrolled to its newest entry. */
  async isAtBottom(): Promise<boolean> {
    return this.scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 64);
  }
}
