import type { FrameLocator, Locator, Page } from '@playwright/test';

/** The page an app's own page is drawn in, `/x/<id>`. */
export function appPage(page: Page): Locator {
  return page.getByTestId('extension-page');
}

/**
 * What one app draws in one place, reached inside the sandboxed frame it runs
 * in (DOR-3293).
 *
 * An app's screens are no longer part of the DorkOS page: each view is its own
 * frame, titled with the app's name, so a locator on the page never sees the
 * app's headings, fields or buttons. The scope matters as much as the title.
 * Every running app also keeps one hidden frame for its registrations, with the
 * same title, so an unscoped `iframe[title=…]` matches two frames and a
 * locator inside it fails on strict mode. Scope it to the place the view is
 * shown: the page, a right-panel tab, a status-bar item.
 *
 * @param scope - The place the view is drawn in, e.g. {@link appPage}.
 * @param appName - The app's name, as its manifest gives it.
 */
export function appFrame(scope: Locator, appName: string): FrameLocator {
  return scope.locator(`iframe[title="${appName}"]`).contentFrame();
}
