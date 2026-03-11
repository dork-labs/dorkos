import type { Page, Locator } from '@playwright/test';

/** Page Object Model for the agent sidebar with tabbed views. */
export class AgentSidebarPage {
  readonly page: Page;
  readonly newChatButton: Locator;
  readonly sessionList: Locator;
  readonly tabList: Locator;
  readonly sessionsTab: Locator;
  readonly schedulesTab: Locator;
  readonly connectionsTab: Locator;
  readonly sessionsPanel: Locator;
  readonly schedulesPanel: Locator;
  readonly connectionsPanel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newChatButton = page.getByRole('button', { name: /new session/i });
    this.sessionList = page.locator('[data-testid="session-list"]');
    this.tabList = page.getByRole('tablist', { name: 'Sidebar views' });
    this.sessionsTab = page.getByRole('tab', { name: 'Sessions' });
    this.schedulesTab = page.getByRole('tab', { name: 'Schedules' });
    this.connectionsTab = page.getByRole('tab', { name: 'Connections' });
    this.sessionsPanel = page.locator('#sidebar-tabpanel-sessions');
    this.schedulesPanel = page.locator('#sidebar-tabpanel-schedules');
    this.connectionsPanel = page.locator('#sidebar-tabpanel-connections');
  }

  /** Create a new session by clicking the "New session" button. */
  async createNewSession() {
    await this.newChatButton.click();
  }

  /** Select a session by its index in the list. */
  async selectSession(index: number) {
    const sessions = this.sessionList.locator('[data-testid="session-item"]');
    await sessions.nth(index).click();
  }

  /** Get the number of sessions in the list. */
  async getSessionCount() {
    return this.sessionList.locator('[data-testid="session-item"]').count();
  }

  /** Switch to a sidebar tab by name. */
  async switchTab(name: 'sessions' | 'schedules' | 'connections') {
    const tabMap = {
      sessions: this.sessionsTab,
      schedules: this.schedulesTab,
      connections: this.connectionsTab,
    };
    await tabMap[name].click();
  }

  /** Get the currently active tab name. */
  async getActiveTab(): Promise<string> {
    const tabs = await this.tabList.getByRole('tab').all();
    for (const tab of tabs) {
      if ((await tab.getAttribute('aria-selected')) === 'true') {
        const id = await tab.getAttribute('id');
        return id?.replace('sidebar-tab-', '') ?? '';
      }
    }
    return '';
  }
}
