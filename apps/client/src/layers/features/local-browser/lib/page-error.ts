import {
  pageErrorKind,
  pageErrorTitle,
  type PageErrorKind,
} from '@dorkos/shared/local-browser-page-error';

/** What a page-error block's button does. Retry reloads only the address the shell recorded. */
export type PageErrorAction = 'retry' | 'back' | 'reload' | 'search';

/** One page-error block, ready to draw (spec DOR-4420 §8). */
export interface PageErrorBlockCopy {
  kind: PageErrorKind;
  title: string;
  line: string;
  primary: { label: string; action: PageErrorAction };
  secondary?: { label: string; action: PageErrorAction };
}

const TRY_AGAIN = { label: 'Try again', action: 'retry' } as const;
const GO_BACK = { label: 'Go back', action: 'back' } as const;
const SEARCH = { label: 'Search for it', action: 'search' } as const;

/**
 * The block for one failed load, or `null` when nothing should show (`ERR_ABORTED`).
 *
 * @param failure - The shell's record of the failure; `code` is `CRASHED` for a crash.
 * @param typed - Whether the person typed the address that failed. Only then does
 *   "Search for it" appear: an agent's address is never searched for.
 */
export function pageErrorBlock(
  failure: { code: string; host: string },
  typed: boolean
): PageErrorBlockCopy | null {
  const kind = failure.code === 'CRASHED' ? 'crashed' : pageErrorKind(failure.code);
  if (!kind) return null;
  const { host } = failure;
  const title = pageErrorTitle(kind, host);
  switch (kind) {
    case 'name-not-found':
      return {
        kind,
        title,
        line: 'Check the spelling. If it’s right, the site may be down.',
        primary: TRY_AGAIN,
        ...(typed ? { secondary: SEARCH } : {}),
      };
    case 'no-response':
      return {
        kind,
        title,
        line: 'The site may be down or busy. Try again in a moment.',
        primary: TRY_AGAIN,
      };
    case 'offline':
      return {
        kind,
        title,
        line: 'Check your internet connection, then try again.',
        primary: TRY_AGAIN,
      };
    case 'certificate':
      // No way through: agents drive this browser.
      return {
        kind,
        title,
        line: `${host}’s certificate isn’t valid, so DorkOS stopped loading it.`,
        primary: GO_BACK,
      };
    case 'blocked-by-dorkos':
      return {
        kind,
        title,
        line: 'Pages like this stay closed to the Agent browser.',
        primary: GO_BACK,
      };
    case 'blocked-by-policy':
      return {
        kind,
        title,
        line: 'Your network or computer won’t let this browser open it.',
        primary: GO_BACK,
      };
    case 'too-many-redirects':
      return {
        kind,
        title,
        line: 'Forgetting saved sign-ins for every site may fix it.',
        primary: TRY_AGAIN,
      };
    case 'crashed':
      return {
        kind,
        title,
        line: 'Reload it to start it again.',
        primary: { label: 'Reload', action: 'reload' },
      };
  }
}

/**
 * The DuckDuckGo address for a person's typed search (spec DOR-4420 §5).
 *
 * @param typed - Exactly what the person typed.
 */
export function searchAddress(typed: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(typed.trim())}`;
}
