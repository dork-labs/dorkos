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
  readonly inferenceStreaming: Locator;
  readonly inferenceComplete: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    this.input = page.getByRole('combobox', { name: /message claude/i });
    this.sendButton = page.getByRole('button', { name: /send message/i });
    this.messageList = page.locator('[data-testid="message-list"]');
    this.panel = page.locator('[data-testid="chat-panel"]');
    this.inferenceStreaming = page.locator('[data-testid="inference-indicator-streaming"]');
    this.inferenceComplete = page.locator('[data-testid="inference-indicator-complete"]');
  }

  /** Navigate to the app and ensure a chat session is active. */
  async goto(sessionId?: string, options?: { dir?: string }) {
    let url = sessionId ? `/session?session=${sessionId}` : '/session';
    if (options?.dir) {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}dir=${encodeURIComponent(options.dir)}`;
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

  /** Wait for a full streaming response cycle to complete. */
  async waitForResponse(timeoutMs = 60_000) {
    await this.inferenceStreaming.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await this.inferenceStreaming.waitFor({ state: 'hidden', timeout: timeoutMs });
  }

  /** Wait for the streaming indicator to become visible (mid-stream). */
  async waitForStreamingStart(timeoutMs = 10_000) {
    await this.inferenceStreaming.waitFor({ state: 'visible', timeout: timeoutMs });
  }

  /** Wait for the complete indicator to appear after streaming ends. */
  async waitForCompleteIndicator(timeoutMs = 60_000) {
    await this.inferenceComplete.waitFor({ state: 'visible', timeout: timeoutMs });
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
}
