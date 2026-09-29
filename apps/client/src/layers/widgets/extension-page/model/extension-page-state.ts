/**
 * What the page at `/x/<extensionId>/<path>` should show, decided from the
 * registry and the extension list (spec `flow-multiproject` §6.5).
 *
 * @module widgets/extension-page/model/extension-page-state
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { ExtensionPageAtPath } from '@/layers/shared/model';

/** The one thing an extension page route can be showing. */
export type ExtensionPageState =
  /** The extensions have not finished loading: a deep link on reload lands here first. */
  | { kind: 'loading' }
  /** The page, with its param values. */
  | { kind: 'page'; at: ExtensionPageAtPath & { match: NonNullable<ExtensionPageAtPath['match']> } }
  /** No extension by that id on this machine. */
  | { kind: 'not-installed'; name: string }
  /** Installed, waiting for a person to let it run. */
  | { kind: 'not-allowed'; name: string }
  /** Installed and allowed, but turned off. */
  | { kind: 'turned-off'; name: string }
  /** It could not be built or started. */
  | { kind: 'broken'; name: string }
  /** It runs, and has no page at this address. */
  | { kind: 'no-page'; name: string };

/** Statuses of an extension that could not be built or started. */
const BROKEN_STATUSES: ReadonlySet<ExtensionRecordPublic['status']> = new Set([
  'invalid',
  'incompatible',
  'compile_error',
  'activate_error',
]);

/**
 * Decide what the page route shows.
 *
 * A registered page wins whatever else is true, so a page never flickers to an
 * empty state while the extension list refreshes. Before the first load
 * finishes the answer is always `loading`: the extension may be about to
 * register this very page, and a reload must show a skeleton, never a 404.
 *
 * @param at - The address, and the page that answers it (if any).
 * @param extensions - Every extension the server discovered.
 * @param ready - Whether the first extension load has finished.
 * @param settling - Whether a reload is swapping the loaded set right now; the
 *   page may be about to come back, so this also answers `loading`.
 */
export function extensionPageState(
  at: ExtensionPageAtPath,
  extensions: readonly ExtensionRecordPublic[],
  ready: boolean,
  settling = false
): ExtensionPageState {
  if (at.match !== null) return { kind: 'page', at: { ...at, match: at.match } };
  if (!ready || settling) return { kind: 'loading' };

  const record = extensions.find((extension) => extension.id === at.extensionId);
  if (!record) return { kind: 'not-installed', name: at.extensionId };

  const name = record.manifest.name;
  if (BROKEN_STATUSES.has(record.status)) return { kind: 'broken', name };
  if (record.status === 'disabled') return { kind: 'turned-off', name };
  if (!record.approvedToRun) return { kind: 'not-allowed', name };
  return { kind: 'no-page', name };
}
