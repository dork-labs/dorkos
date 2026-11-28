import type { ComputerTransport } from '@dorkos/shared/transport-computers';
import {
  ComputerStatusSchema,
  ComputerSessionSchema,
  ComputerControlLeaseSchema,
  ComputerFrameSchema,
} from '@dorkos/shared/computer-schemas';
import { createTransportApiClient } from './api-client';

/** Bind computer operations to the current authenticated DorkOS server. */
export function createComputerMethods(baseUrl: string, clientId: () => string): ComputerTransport {
  const api = createTransportApiClient(baseUrl);
  // Every computer call names this window in its own `X-Client-Id` header.
  const own = () => ({ headers: { 'X-Client-Id': clientId() } });
  return {
    getComputer: async () => ComputerStatusSchema.parse(await api.call('computers.get', own())),
    createComputer: async () =>
      ComputerStatusSchema.parse(await api.call('computers.create', own())),
    startComputer: async () => ComputerStatusSchema.parse(await api.call('computers.start', own())),
    stopComputer: async () => ComputerStatusSchema.parse(await api.call('computers.stop', own())),
    signInComputer: async () =>
      ComputerStatusSchema.parse(await api.call('computers.signIn', own())),
    createComputerSession: async () =>
      ComputerSessionSchema.parse(await api.call('computers.createSessions', own())),
    acquireComputerControl: async () =>
      ComputerControlLeaseSchema.parse(await api.call('computers.createControl', own())),
    releaseComputerControl: async (leaseId) => {
      await api.call('computers.deleteControl', { ...own(), body: { leaseId } });
    },
    sendComputerInput: async (input) => {
      await api.call('computers.createInput', { ...own(), body: input });
    },
    getComputerFrame: async () =>
      ComputerFrameSchema.parse(await api.call('computers.getFrame', own())),
  };
}
