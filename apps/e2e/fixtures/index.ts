import { test as base } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage';
import { DashboardSidebarPage } from '../pages/DashboardSidebarPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BasePage } from '../pages/BasePage';
import { TasksPage } from '../pages/TasksPage';
import { ConnectionsPage } from '../pages/ConnectionsPage';
import { AuthPage } from '../pages/AuthPage';
import { RightPanelPage } from '../pages/RightPanelPage';
import { RoomsPage } from '../pages/RoomsPage';
import { HomeSurfacePage } from '../pages/HomeSurfacePage';
import { ControlCenterPage } from '../pages/ControlCenterPage';
import { RoomsApi } from './rooms-api';
import { TeamRoomApi } from './team-room-api';
import { TasksApi } from './tasks-api';

type DorkOSFixtures = {
  basePage: BasePage;
  chatPage: ChatPage;
  dashboardSidebar: DashboardSidebarPage;
  settingsPage: SettingsPage;
  tasksPage: TasksPage;
  connectionsPage: ConnectionsPage;
  authPage: AuthPage;
  rightPanel: RightPanelPage;
  roomsPage: RoomsPage;
  homeSurface: HomeSurfacePage;
  controlCenter: ControlCenterPage;
  roomsApi: RoomsApi;
  teamRoomApi: TeamRoomApi;
  tasksApi: TasksApi;
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
  connectionsPage: async ({ page }, use) => {
    await use(new ConnectionsPage(page));
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
  homeSurface: async ({ page }, use) => {
    await use(new HomeSurfacePage(page));
  },
  controlCenter: async ({ page }, use) => {
    await use(new ControlCenterPage(page));
  },
  // Seeds this test's rooms and agents, and puts them away again — the suite
  // shares one server, so nothing may outlive the test that made it.
  roomsApi: async ({ request }, use) => {
    const api = new RoomsApi(request);
    await use(api);
    await api.cleanup();
  },
  // The one room a test may not create: #team is opened once per install and
  // cannot be deleted, so this helper works against the room already there and
  // puts back every change it made — including an archive, which every other
  // page on this server can see.
  teamRoomApi: async ({ request }, use) => {
    const api = new TeamRoomApi(request);
    await use(api);
    await api.cleanup();
  },
  // Seeds this test's schedules and deletes them again — same reason as above.
  tasksApi: async ({ request }, use) => {
    const api = new TasksApi(request);
    await use(api);
    await api.cleanup();
  },
});

export { expect } from '@playwright/test';
