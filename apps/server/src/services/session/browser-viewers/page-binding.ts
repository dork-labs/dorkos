import type { Page } from 'playwright-core';
import { startChromeScreencast } from './chrome-screencast.js';
import { BrowserViewerError, type ViewerPage, type ViewerPageIdentity } from './viewer-contract.js';

/** Existing service facts only. No address, browser handle or acquisition operation crosses this seam. */
export interface ViewerSelection {
  readonly identity: ViewerPageIdentity;
  readonly page: Page;
}

interface Binding {
  selection: ViewerSelection;
  controller: AbortController;
  view: ViewerPage;
}

function sameSelection(a: ViewerSelection, b: ViewerSelection | undefined): boolean {
  return (
    b !== undefined &&
    a.page === b.page &&
    a.identity.chatId === b.identity.chatId &&
    a.identity.profileId === b.identity.profileId &&
    a.identity.connectionId === b.identity.connectionId &&
    a.identity.tabId === b.identity.tabId &&
    !a.page.isClosed()
  );
}

/** Adapts the existing single holder until the page broker supplies this read-only port. */
export class BrowserViewerBinding {
  private binding?: Binding;

  constructor(
    private readonly selected: () => ViewerSelection | undefined,
    private readonly authorize: (chatId: string) => Promise<void>,
    private readonly protect: () => void = () => undefined
  ) {}

  /** Resolve only the current chat's exact existing Page, checking grants around awaits. */
  readonly resolve = async (chatId: string): Promise<ViewerPage> => {
    this.refresh();
    const selection = this.selected();
    if (!selection || selection.identity.chatId !== chatId || selection.page.isClosed())
      throw new BrowserViewerError('viewer_unavailable');
    if (!this.binding) this.binding = this.create(selection);
    const view = this.binding.view;
    await view.assertCurrent();
    return view;
  };

  /** Called synchronously when service ownership or connection facts change. */
  refresh(): void {
    const binding = this.binding;
    if (binding && !sameSelection(binding.selection, this.selected())) binding.controller.abort();
  }

  /** End the current generation before asynchronous connection teardown starts. */
  revoke(): void {
    this.binding?.controller.abort();
  }

  private create(current: ViewerSelection): Binding {
    const selection = { page: current.page, identity: Object.freeze({ ...current.identity }) };
    const controller = new AbortController();
    const { page } = selection;
    const refuse = () => {
      try {
        if (controller.signal.aborted || !sameSelection(selection, this.selected()))
          throw new BrowserViewerError('viewer_unavailable');
        this.protect();
      } catch {
        controller.abort();
        throw new BrowserViewerError('viewer_unavailable');
      }
    };
    const assertCurrent = async () => {
      try {
        refuse();
        await this.authorize(selection.identity.chatId);
        refuse();
      } catch {
        controller.abort();
        throw new BrowserViewerError('viewer_unavailable');
      }
    };
    const ended = () => controller.abort();
    const navigated = (frame: unknown) => {
      if (frame === page.mainFrame()) ended();
    };
    const binding: Binding = {
      selection,
      controller,
      view: {
        identity: selection.identity,
        signal: controller.signal,
        assertLive: refuse,
        assertCurrent,
        start: async (receive) => {
          await assertCurrent();
          const stop = await startChromeScreencast(page, (frame) => {
            // No async admission here: delivery checks grants; this fence drops late callbacks.
            if (!controller.signal.aborted && sameSelection(selection, this.selected()))
              receive(frame);
          });
          const detach = () => {
            void stop();
          };
          controller.signal.addEventListener('abort', detach, { once: true });
          try {
            await assertCurrent();
          } catch (error) {
            await stop();
            throw error;
          }
          return async () => {
            controller.signal.removeEventListener('abort', detach);
            await stop();
          };
        },
      },
    };
    controller.signal.addEventListener(
      'abort',
      () => {
        page.off('framenavigated', navigated);
        page.off('close', ended);
        if (this.binding === binding) this.binding = undefined;
      },
      { once: true }
    );
    page.on('framenavigated', navigated);
    page.on('close', ended);
    return binding;
  }
}
