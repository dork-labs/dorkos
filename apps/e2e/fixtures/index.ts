import { test as base } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage';
import { SessionSidebarPage } from '../pages/SessionSidebarPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BasePage } from '../pages/BasePage';
import { TasksPage } from '../pages/TasksPage';
import { MeshPage } from '../pages/MeshPage';
import { RelayPage } from '../pages/RelayPage';
import { AuthPage } from '../pages/AuthPage';

type DorkOSFixtures = {
  basePage: BasePage;
  chatPage: ChatPage;
  sessionSidebar: SessionSidebarPage;
  settingsPage: SettingsPage;
  tasksPage: TasksPage;
  meshPage: MeshPage;
  relayPage: RelayPage;
  authPage: AuthPage;
};

export const test = base.extend<DorkOSFixtures>({
  basePage: async ({ page }, use) => {
    await use(new BasePage(page));
  },
  chatPage: async ({ page }, use) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto();
    await use(chatPage);
  },
  sessionSidebar: async ({ page }, use) => {
    await use(new SessionSidebarPage(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
  tasksPage: async ({ page }, use) => {
    await use(new TasksPage(page));
  },
  meshPage: async ({ page }, use) => {
    await use(new MeshPage(page));
  },
  relayPage: async ({ page }, use) => {
    await use(new RelayPage(page));
  },
  authPage: async ({ page }, use) => {
    await use(new AuthPage(page));
  },
});

export { expect } from '@playwright/test';
