import { createContext, useContext } from 'react';
import type { Transport } from '@dorkos/shared/transport';

const TransportContext = createContext<Transport | null>(null);

export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: React.ReactNode;
}) {
  return (
    <TransportContext.Provider value={transport}>
      {children}
    </TransportContext.Provider>
  );
}

export function useTransport(): Transport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error('useTransport must be used within a TransportProvider');
  }
  return transport;
}
