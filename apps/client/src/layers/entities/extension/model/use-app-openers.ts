import { useCallback } from 'react';
import { useExtensionNames } from '@/layers/shared/lib/extension-names';

/** The app a canvas document says opened it, in DorkOS's own words. */
export interface AppOpener {
  /** The app's name from DorkOS's records, never from the app or the page. */
  name: string;
  /**
   * Its icon. An app's own icon cannot cross its frame, so this is always the
   * puzzle piece every app wears; kept as a field so a tab draws it one way.
   */
  icon: undefined;
}

/**
 * Look up the app behind a document's "opened by" mark (DOR-3293).
 *
 * The mark is only an id the host wrote on the document's record; the name
 * comes from the installed apps DorkOS lists. An id DorkOS no longer knows
 * names nobody, so the document shows no label at all.
 *
 * @returns A lookup from app id to its name and icon, or `null`.
 */
export function useAppOpeners(): (extensionId: string | undefined) => AppOpener | null {
  const names = useExtensionNames();
  return useCallback(
    (extensionId) => {
      const name = extensionId ? names[extensionId] : undefined;
      return name ? { name, icon: undefined } : null;
    },
    [names]
  );
}
