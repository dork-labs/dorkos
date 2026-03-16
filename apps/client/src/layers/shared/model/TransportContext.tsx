import { createContext, useContext } from 'react';
import type { Transport } from '@dorkos/shared/transport';

const TransportContext = createContext<Transport | null>(null);

/** Provide a {@link Transport} instance to the component tree via React context. */
export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: React.ReactNode;
}) {
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
