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
  roomsApi: RoomsApi;
  teamRoomApi: TeamRoomApi;
  tasksApi: TasksApi;
};

/**
 * The client's opt-out key for its persisted boot cache.
 *
 * Spelled here rather than imported: `apps/e2e` depends on no workspace package,
 * and one string is not worth making it depend on the client bundle. The value
 * is pinned from the other side — `query-persister.test.ts` asserts this exact
 * literal and names this file — so a rename reddens a unit test that says where
 * to look.
 */
export const BOOT_CACHE_DISABLED_KEY = 'dorkos:boot-cache-disabled';

export const test = base.extend<DorkOSFixtures>({
  /**
   * Every spec gets a COLD cockpit, unless it says otherwise.
   *
   * The cockpit remembers its sidebar between loads (`shared/lib/query-persister.ts`),
   * which is right for a person and wrong for a suite written against a cold
   * first paint. A fresh context per test is not enough: within one test, the
   * second `page.goto` restores what the first left, so specs that assert on
   * paint order, scroll anchoring, or a live lane's first frame start racing a
   * warm boot they were never written for — and CI's slower machines widen every
   * one of those races.
   *
   * So the suite opts OUT by default and `dashboard-sidebar/boot-stability.spec.ts`
   * opts back in, because warm boot is the thing it tests. Anything else that
   * comes to depend on warm behaviour should opt in the same way, deliberately,
   * rather than inherit it.
   */
  context: async ({ context }, use) => {
    await context.addInitScript((key) => {
      window.localStorage.setItem(key, '1');
    }, BOOT_CACHE_DISABLED_KEY);
    await use(context);
  },
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
