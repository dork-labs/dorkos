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
import { HarnessRepoApi } from './harness-repo';
import { TeamRoomApi } from './team-room-api';
import { TasksApi } from './tasks-api';
import { soleAccess } from './sole-access';

type DorkOSFixtures = {
  /**
   * Sole access to the shared sidebar panel, for the tests that asked for it.
   *
   * Automatic rather than requested, so a spec that wears the tag cannot forget
   * to take the lock — see `fixtures/sole-access.ts` for what is shared and why
   * a namespace cannot isolate it.
   */
  soleSidebar: void;
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
  harnessRepo: HarnessRepoApi;
  teamRoomApi: TeamRoomApi;
  tasksApi: TasksApi;
};

export const test = base.extend<DorkOSFixtures>({
  // Keyed on `baseURL` because the panel is shared per SERVER: two checkouts
  // running on their own ports have their own sidebars and must not queue behind
  // each other. A run with no baseURL configured has one notional server, so one
  // lock is still the right answer.
  soleSidebar: [
    async ({ baseURL }, use, testInfo) => {
      await soleAccess(baseURL ?? 'default', testInfo, async () => {
        await use();
      });
    },
    { auto: true },
  ],
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
  // Stages a repository under this test's own agent root and removes it again.
  // It takes `roomsApi` rather than `request` because the tree has to land
  // inside that instance's `agentRoot` — see the fixture's header for what goes
  // wrong when it does not — and because depending on it is what makes
  // Playwright tear this down FIRST, before the root it wrote into goes.
  harnessRepo: async ({ roomsApi }, use) => {
    const api = new HarnessRepoApi(roomsApi);
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
