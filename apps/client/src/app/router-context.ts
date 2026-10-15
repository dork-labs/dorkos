import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';

export interface RouterContext {
  queryClient: QueryClient;
  transport: Transport;
  /**
   * Make every route match for the chat `sessionId` load again: the page
   * showing it, and a preload a click would reuse. A loader that opened a chat
   * from cache calls it when the background check finds the chat is gone.
   */
  reloadRoute?: (sessionId: string) => void;
}
