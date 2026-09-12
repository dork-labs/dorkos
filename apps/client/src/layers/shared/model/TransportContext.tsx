import { createContext, useContext } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import { setSessionCanvasTransport } from './app-store/app-store-canvas';

const TransportContext = createContext<Transport | null>(null);

/**
 * Provide a {@link Transport} instance to the component tree via React context.
 *
 * It also hands the canvas slice its writer, because that slice is a zustand
 * store rather than a React consumer and cannot read this context itself (spec
 * `canvas-agent-seat` §1.5). Doing it HERE rather than in each app entry is the
 * same reasoning `CanvasService` uses for self-wiring at module scope: both
 * shells — and the Dev Playground, and every test that renders a provider —
 * pass through this one component, so a third one cannot forget. The assignment
 * is idempotent, and it happens during render so the store is ready before any
 * child mounts.
 */
export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: React.ReactNode;
}) {
  setSessionCanvasTransport(transport);
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

/** Retrieve the current {@link Transport} from context, throwing if none is provided. */
export function useTransport(): Transport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error('useTransport must be used within a TransportProvider');
  }
  return transport;
}
