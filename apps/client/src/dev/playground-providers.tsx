import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';

interface PlaygroundProvidersProps {
  /** The query client showcases fetch through. */
  queryClient: QueryClient;
  /** The playground's stubbed transport. */
  transport: Transport;
  /** The playground shell, or a single page under test. */
  children: ReactNode;
}

/**
 * Every context the playground puts a showcase inside — declared once.
 *
 * **This exists because the mount gate drifted from the real mount and hid a
 * fully broken page.** `every-showcase-mounts.test.tsx` used to build its own
 * provider stack "exactly as `main.tsx` wraps the real router", which was true
 * of the app and false of the playground: `Root()` in `main.tsx` branches to
 * `DevPlayground` *before* it reaches `EventStreamProvider`. So the bench
 * supplied a provider production did not, and `/dev/one-bar` — where `OneBar`
 * mounts `InboxBell`, which calls `useEventStream()` — rendered as nothing but
 * red error cards while the gate stayed green.
 *
 * A gate that composes its own providers can only ever prove that SOME
 * composition works. Both callers take this one, so a provider added for the
 * real playground is a provider the gate gets too, and a page that needs one
 * nobody has added fails in both places at once.
 *
 * `EventStreamProvider` sits inside `TransportProvider` for the same reason it
 * does in `main.tsx`: it opens its stream through the transport.
 */
export function PlaygroundProviders({
  queryClient,
  transport,
  children,
}: PlaygroundProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <EventStreamProvider>{children}</EventStreamProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}
