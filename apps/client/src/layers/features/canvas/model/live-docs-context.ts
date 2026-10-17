/**
 * Whether canvas docs are edited live (DOR-2984), as the app shell decided it.
 *
 * The shell reads the `docs.enabled` experiment once ({@link LiveDocsGate})
 * and provides the answer here. The default is off, so a canvas rendered
 * without the shell (a test, a showcase) behaves exactly as it did before
 * live docs existed.
 *
 * @module features/canvas/model/live-docs-context
 */
import { createContext, useContext } from 'react';

/** Whether live doc editing is on. Off unless the shell says otherwise. */
export const LiveDocsContext = createContext(false);

/** Whether live doc editing is on for this canvas. */
export function useLiveDocsOn(): boolean {
  return useContext(LiveDocsContext);
}
