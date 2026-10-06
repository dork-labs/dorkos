import type { QueryClient } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';

export interface RouterContext {
  queryClient: QueryClient;
  transport: Transport;
}
