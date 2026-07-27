import type { BasePage } from '../../pages/BasePage';

/**
 * Open the cockpit with its sidebar showing, once this test's rooms exist.
 *
 * Call it **after** seeding, never before. The sidebar learns about a room made
 * while the page is already up only from a live `room_created` signal on the
 * global event stream — so seeding first and loading second turns a test about
 * how a room renders into a test about whether it caught an event, which is a
 * race and not the subject.
 *
 * @param basePage - The shell page object, from the test's fixtures.
 */
export async function openCockpit(basePage: BasePage): Promise<void> {
  await basePage.goto();
  await basePage.waitForAppReady();
  await basePage.ensureSidebarOpen();
}
