import { test as base } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage';
import { DashboardSidebarPage } from '../pages/DashboardSidebarPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BasePage } from '../pages/BasePage';
import { TasksPage } from '../pages/TasksPage';
import { MeshPage } from '../pages/MeshPage';
import { RelayPage } from '../pages/RelayPage';
import { AuthPage } from '../pages/AuthPage';
import { RightPanelPage } from '../pages/RightPanelPage';
import { RoomsPage } from '../pages/RoomsPage';
import { RoomsApi } from './rooms-api';

type DorkOSFixtures = {
  basePage: BasePage;
  chatPage: ChatPage;
  dashboardSidebar: DashboardSidebarPage;
  settingsPage: SettingsPage;
  tasksPage: TasksPage;
  meshPage: MeshPage;
  relayPage: RelayPage;
  authPage: AuthPage;
  rightPanel: RightPanelPage;
  roomsPage: RoomsPage;
  roomsApi: RoomsApi;
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
  dashboardSidebar: async ({ page }, use) => {
    await use(new DashboardSidebarPage(page));
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
  rightPanel: async ({ page }, use) => {
    await use(new RightPanelPage(page));
  },
  roomsPage: async ({ page }, use) => {
    await use(new RoomsPage(page));
  },
  // Seeds this test's rooms and agents, and puts them away again — the suite
  // shares one server, so nothing may outlive the test that made it.
  roomsApi: async ({ request }, use) => {
    const api = new RoomsApi(request);
    await use(api);
    await api.cleanup();
  },
});

export { expect } from '@playwright/test';
