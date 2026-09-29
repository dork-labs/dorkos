import { expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

/** Page Object Model for the main chat interface. */
export class ChatPage {
  readonly page: Page;
  readonly basePage: BasePage;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly panel: Locator;
  /**
   * Matches while a turn is running in this chat — streaming, or parked on a
   * person (an approval, a question, a capability hold) — and matches nothing
   * once it has ended. Reads the panel's `data-turn-status` and
   * `data-turn-lifecycle`, which mirror the turn's own state — never the lane's
   * words or the composer's label, which a higher-priority rung (an Ask, a
   * progress bar, an edited queued draft) can cover while the turn is still
   * running (DOR-2546). The lifecycle is needed because the rendered status
   * reads a parked turn as `idle`.
   */
  readonly turnRunning: Locator;
  /** The finished turn's summary in the session's live lane — shown briefly after a turn ends. */
  readonly turnComplete: Locator;
  readonly commandPalette: Locator;
  readonly paletteOptions: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    this.input = page.getByRole('combobox', { name: /^(message |send a message)/i });
    this.sendButton = page.getByRole('button', { name: /send message/i });
    this.messageList = page.locator('[data-testid="message-list"]');
    this.panel = page.locator('[data-testid="chat-panel"]');
    this.turnRunning = page.locator(
      '[data-testid="chat-panel"]:is([data-turn-status="streaming"], [data-turn-lifecycle="blocked"])'
    );
    this.turnComplete = page.locator(
      '[data-slot="live-lane"][data-lane-scope="session"] [data-testid="lane-complete"]'
    );
    // Inline slash-command list (SlashCommandList.tsx): a listbox whose rows are
    // role="option" with ids `command-item-{n}`.
    this.commandPalette = page.locator('#command-palette-listbox');
    this.paletteOptions = this.commandPalette.getByRole('option');
  }

  /** Navigate to the app and ensure a chat session is active. */
  async goto(sessionId?: string, options?: { dir?: string; runtime?: string }) {
    let url = sessionId ? `/session?session=${sessionId}` : '/session';
    if (options?.dir) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}dir=${encodeURIComponent(options.dir)}`;
    }
    // Launch-time runtime selection — survives the loader's session-mint
    // redirect and is sent as the first message's runtime hint.
    if (options?.runtime) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}runtime=${encodeURIComponent(options.runtime)}`;
    }
    await this.page.goto(url);
    await this.basePage.waitForAppReady();
    // The chat panel is always rendered (even without an active session it shows
    // the welcome screen with a ready input box). Just wait for it to be visible.
    await this.panel.waitFor({ state: 'visible', timeout: 10_000 });
  }

  async sendMessage(text: string) {
    await this.input.fill(text);
    await this.sendButton.click();
  }

  /**
   * Send `text` and only return once a turn has really started on it.
   *
   * `goto` waits for the app shell and the chat panel, and neither proves a send
   * can land. The composer is a CONTROLLED field: until the session and its
   * agent have hydrated, a `fill` can be reverted by the next render, after
   * which `sendMessage`'s click sends an empty composer and silently does
   * nothing. The spec then waits out its timeout on whatever the turn was
   * supposed to produce and reports a missing CARD instead of a missing SEND —
   * which is a diagnosis pointing at the wrong half of the system.
   *
   * So this is a barrier that proves the thing the assertions depend on rather
   * than something standing next to it (DOR-1213's lesson):
   *
   * 1. the composer is editable — NOT the send button, which does not exist on
   *    an empty composer, so waiting for it here could never pass;
   * 2. the send button appears after the fill, which is the app's own signal
   *    that a session and an agent resolved AND that the field kept the draft;
   * 3. the person's message is in the transcript, and
   * 4. the agent has BEGUN answering it — one MORE reply than before this send,
   *    never merely "a reply exists", which is already true from the second send
   *    onward and would let the previous turn's answer stand in for this one.
   *
   * Step 4 is the one worth arguing for. An optimistic user message can be wiped
   * when the session's snapshot arrives, leaving the transcript back at "Start a
   * conversation" with no turn ever started — and a barrier that stopped at step
   * 3 passes in exactly that case. It follows that every scenario a caller
   * drives must SAY something before it blocks; `todo-progress` did not, and
   * that cost three failures until it was given an opening line.
   *
   * @param text - The message to send; must be distinctive enough to find.
   * @param timeoutMs - Ceiling for each wait; a web-first assertion returns as
   *   soon as it is satisfied, so this costs nothing on a healthy run.
   */
  async sendAndLand(text: string, timeoutMs = 30_000) {
    const replies = this.page.locator('[data-testid="message-item"][data-role="assistant"]');
    // Counted BEFORE the send, because "an assistant message exists" is already
    // true on every send after the first — a `.first()` barrier would be
    // satisfied by the PREVIOUS turn's reply and prove nothing about this one.
    const repliesBefore = await replies.count();

    await expect(this.input).toBeEnabled({ timeout: timeoutMs });
    await this.input.fill(text);
    await expect(this.sendButton).toBeEnabled({ timeout: timeoutMs });
    await this.sendButton.click();
    await expect(
      this.page.locator('[data-testid="message-item"][data-role="user"]').filter({ hasText: text })
    ).toBeVisible({ timeout: timeoutMs });
    await expect(replies).toHaveCount(repliesBefore + 1, { timeout: timeoutMs });
  }

  /**
   * Wait until no turn is running in this chat.
   *
   * A turn parked on an approval or a question has NOT ended, so this waits
   * through it: answer the prompt first, or this runs to its timeout.
   *
   * On its own this proves nothing about a turn that has not started yet — it
   * passes at once on an idle chat. So call it only after something has shown
   * the turn began: {@link sendAndLand}, a visible {@link turnRunning}, or
   * content the turn produced. `sendMessage` followed by this is the vacuous
   * pairing the old `waitForResponse` was (DOR-2546).
   *
   * @param timeoutMs - How long the turn may take to finish.
   */
  async waitForTurnToEnd(timeoutMs = 60_000) {
    await expect(this.turnRunning).toHaveCount(0, { timeout: timeoutMs });
  }

  /** Get all message items in the message list. */
  async getMessages() {
    return this.messageList.locator('[data-testid="message-item"]');
  }

  /** Get the last assistant message element. */
  async lastAssistantMessage() {
    return this.messageList.locator('[data-testid="message-item"][data-role="assistant"]').last();
  }

  /** Get all tool call cards within the message list. */
  get toolCallCards() {
    return this.messageList.locator('[data-testid="tool-call-card"]');
  }

  /** Get the active tool approval prompt (if any). */
  get toolApproval() {
    return this.messageList.locator('[data-testid="tool-approval"]');
  }

  /** Get the Approve button inside an active tool approval. */
  get approveButton() {
    return this.toolApproval.getByRole('button', { name: /approve/i });
  }

  /** Get the Deny button inside an active tool approval. */
  get denyButton() {
    return this.toolApproval.getByRole('button', { name: /deny/i });
  }

  /** Get the current session ID from the URL. */
  async getSessionId(): Promise<string | null> {
    const url = new URL(this.page.url());
    return url.searchParams.get('session');
  }

  /**
   * Open the inline slash-command palette by typing `query` (e.g. `'/'` or
   * `'/compress'`) into the composer, and wait for the listbox to appear.
   * Uses real keystrokes so the `/` trigger detection and cursor tracking fire
   * exactly as they do for a user.
   */
  async openCommandPalette(query: string) {
    await this.input.click();
    await this.input.pressSequentially(query);
    await this.commandPalette.waitFor({ state: 'visible', timeout: 10_000 });
  }

  /** A single palette row by its canonical slash token (e.g. `'/compact'`). */
  paletteRow(fullCommand: string): Locator {
    return this.paletteOptions.filter({
      has: this.page.getByText(fullCommand, { exact: true }),
    });
  }
}
