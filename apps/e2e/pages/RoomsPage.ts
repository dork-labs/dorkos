import type { Page, Locator } from '@playwright/test';

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

  /** Every `post` in the open room, oldest first. */
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

  constructor(page: Page) {
    this.page = page;
    this.channels = this.section('Channels');
    this.directMessages = this.section('Direct messages');
    this.roomHeader = page
      .locator('header')
      .filter({ has: page.locator('[data-slot="room-title"]') });
    this.roomHeading = this.roomHeader.getByRole('heading');
    this.scroller = page.locator('[data-testid="room-timeline"]').locator('xpath=..');
    this.entries = page.getByTestId('room-entry');
    this.notices = page.getByTestId('room-notice');
    this.presenceLine = page.getByTestId('room-presence');
    this.presenceAnnouncer = page.getByTestId('room-presence-announcer');
    this.stalledNotice = page.getByText("New messages aren't coming through right now.");
    this.reconnectButton = page.getByRole('button', { name: 'Reconnect' });
  }

  /**
   * One sidebar section, found by its collapse header.
   *
   * @param label - The header's label, exactly as `RoomSectionHeader` is given it.
   */
  section(label: string): Locator {
    return this.page
      .locator('[data-slot="sidebar-group"]')
      .filter({ has: this.page.getByRole('button', { name: label, exact: true }) });
  }

  /**
   * One room's sidebar row, anywhere in the sidebar.
   *
   * @param spokenName - The room's spoken name: `#slug` for a channel, the title
   *   for a direct message.
   */
  row(spokenName: string): Locator {
    return this.rowIn(this.page.locator('[data-slot="sidebar-group"]'), spokenName);
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

  /** The mark drawn beside the open room's name in its masthead. */
  get headerMark(): Locator {
    return this.roomHeader.locator('[data-slot="room-avatar"]');
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
    await this.channels.getByRole('button', { name: 'New channel' }).click();
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

  /** Open the "+" beside Direct messages. */
  async openDirectMessagePicker(): Promise<void> {
    await this.directMessages.getByRole('button', { name: 'New direct message' }).click();
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
   * One entry in the open room, found by what it says.
   *
   * @param text - The entry's exact body text.
   */
  entry(text: string): Locator {
    return this.entries.filter({ has: this.page.getByText(text, { exact: true }) });
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
