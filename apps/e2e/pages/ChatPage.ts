import type { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class ChatPage {
  readonly page: Page;
  readonly basePage: BasePage;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly panel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.basePage = new BasePage(page);
    this.input = page.getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: /send/i });
    this.messageList = page.locator('[data-testid="message-list"]');
    this.panel = page.locator('[data-testid="chat-panel"]');
  }

  /** Navigate to the app and ensure a chat session is active. */
  async goto(sessionId?: string) {
    const url = sessionId ? `/?session=${sessionId}` : '/';
    await this.page.goto(url);
    await this.basePage.waitForAppReady();

    // If no session specified, create one via the sidebar
    if (!sessionId) {
      const hasChatPanel = await this.panel.isVisible().catch(() => false);
      if (!hasChatPanel) {
        await this.basePage.ensureSidebarOpen();
        await this.page.getByRole('button', { name: /new chat/i }).click();
        await this.panel.waitFor({ state: 'visible', timeout: 10_000 });
      }
    } else {
      await this.panel.waitFor({ state: 'visible', timeout: 10_000 });
    }
  }

  async sendMessage(text: string) {
    await this.input.fill(text);
    await this.sendButton.click();
  }

  async waitForResponse(timeoutMs = 60_000) {
    await this.page
      .locator('[data-testid="inference-indicator-streaming"]')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await this.page
      .locator('[data-testid="inference-indicator-streaming"]')
      .waitFor({ state: 'hidden', timeout: timeoutMs });
  }

  async getMessages() {
    return this.messageList.locator('[data-testid="message-item"]');
  }

  async lastAssistantMessage() {
    return this.messageList
      .locator('[data-testid="message-item"][data-role="assistant"]')
      .last();
  }
}
