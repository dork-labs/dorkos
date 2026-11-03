/**
 * Full screen in a window an agent drives (DOR-3218).
 *
 * Full screen could take away the orange frame. No profile setting refuses it, so
 * two things stand in, neither of which puts anything in the page:
 *
 * - A `Permissions-Policy: fullscreen=()` response header on each document, added
 *   to the browser's own response. It's added beside the site's headers and never
 *   replaces one. It's a speed bump: a blank popup or a `blob:` page has no response
 *   to add it to.
 * - Agent reads and actions are refused while any page is in full screen, read from
 *   an isolated world a page can't lie to. If that can't be read, the answer is yes.
 *
 * This doesn't stop a page hiding the frame. Never say it does.
 */
import type { CDPSession, Page } from 'playwright-core';
import { logger } from '../../../../lib/logger.js';
import { LocalBrowserError } from '../errors.js';

const CHECK_TIMEOUT_MS = 2_000;

/** What the guard needs of a DevTools session on one page. */
export type GuardSession = Pick<CDPSession, 'send' | 'on'>;

/** One response header, as the browser's DevTools protocol lists them. */
export interface ResponseHeader {
  name: string;
  value: string;
}

/**
 * The site's own headers, untouched, with the refusal after them. In a repeated
 * Permissions-Policy header the last value of a directive wins.
 *
 * @param headers - The response's headers.
 */
export function withFullScreenRefused(headers: readonly ResponseHeader[]): ResponseHeader[] {
  return [...headers, { name: 'Permissions-Policy', value: 'fullscreen=()' }];
}

/** Watches each page of an agent's window for full screen. */
export class FullScreenGuard {
  private readonly sessions = new Map<Page, Promise<GuardSession>>();

  constructor(
    private readonly open: (page: Page) => Promise<GuardSession> = (page) =>
      page.context().newCDPSession(page)
  ) {}

  /**
   * Start adding the refusal to a page's documents. A page that can't be watched
   * is caught by {@link inFullScreen}, which then says yes.
   *
   * @param page - A page of the agent's window.
   */
  watch(page: Page): void {
    const session = (async () => this.open(page))();
    this.sessions.set(page, session);
    void session
      .then(async (cdp) => {
        cdp.on('Fetch.requestPaused', (event) => void this.answer(cdp, event));
        await cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }],
        });
      })
      .catch((err: unknown) => logger.debug('[Browser] Can’t add the full screen header', { err }));
  }

  /**
   * Whether a page is in full screen, or that can't be told.
   *
   * @param page - A page of the agent's window.
   */
  async inFullScreen(page: Page): Promise<boolean> {
    try {
      const session = this.sessions.get(page);
      if (!session) return true;
      const cdp = await session;
      const answer = await Promise.race([
        this.read(cdp),
        new Promise<undefined>((resolve) => setTimeout(resolve, CHECK_TIMEOUT_MS)),
      ]);
      return answer !== false;
    } catch {
      return true;
    }
  }

  /** Refuse an agent while any watched page is in full screen, or that can't be told. */
  async requireNone(): Promise<void> {
    for (const page of this.sessions.keys()) if (page.isClosed()) this.sessions.delete(page);
    const answers = await Promise.all([...this.sessions.keys()].map((p) => this.inFullScreen(p)));
    if (answers.includes(true))
      throw new LocalBrowserError(
        'full_screen',
        'A page is in full screen. Ask the person to press Esc, then try again.'
      );
  }

  private async read(cdp: GuardSession): Promise<boolean | undefined> {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'dorkos-full-screen-check',
    });
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.fullscreenElement !== null',
      contextId: executionContextId,
      returnByValue: true,
    });
    return typeof result.value === 'boolean' ? result.value : undefined;
  }

  private async answer(
    cdp: GuardSession,
    event: {
      requestId: string;
      responseStatusCode?: number;
      responseStatusText?: string;
      responseHeaders?: ResponseHeader[];
    }
  ): Promise<void> {
    const status = event.responseStatusCode;
    try {
      // A redirect has no document to refuse, and can't be continued as a response.
      if (status === undefined || (status >= 300 && status < 400)) {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
        return;
      }
      await cdp.send('Fetch.continueResponse', {
        requestId: event.requestId,
        responseCode: status,
        responsePhrase: event.responseStatusText || 'OK',
        responseHeaders: withFullScreenRefused(event.responseHeaders ?? []),
      });
    } catch {
      // Never leave a page hanging on this. It goes on without the header.
      await cdp
        .send('Fetch.continueRequest', { requestId: event.requestId })
        .catch(() => undefined);
    }
  }
}
