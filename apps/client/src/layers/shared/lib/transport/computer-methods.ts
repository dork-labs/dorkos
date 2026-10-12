import type { ComputerTransport } from '@dorkos/shared/transport-computers';
import {
  ComputerStatusSchema,
  ComputerSessionSchema,
  ComputerControlLeaseSchema,
  ComputerFrameSchema,
} from '@dorkos/shared/computer-schemas';
import { fetchJSON } from './http-client';

/** Bind computer operations to the current authenticated DorkOS server. */
export function createComputerMethods(baseUrl: string, clientId: () => string): ComputerTransport {
  const request = <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
    fetchJSON<T>(baseUrl, `/computers${path}`, {
      method,
      headers: { 'X-Client-Id': clientId() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    getComputer: async () => ComputerStatusSchema.parse(await request('')),
    createComputer: async () => ComputerStatusSchema.parse(await request('', 'POST')),
    startComputer: async () => ComputerStatusSchema.parse(await request('/start', 'POST')),
    stopComputer: async () => ComputerStatusSchema.parse(await request('/stop', 'POST')),
    signInComputer: async () => ComputerStatusSchema.parse(await request('/sign-in', 'POST')),
    createComputerSession: async () =>
      ComputerSessionSchema.parse(await request('/sessions', 'POST')),
    acquireComputerControl: async () =>
      ComputerControlLeaseSchema.parse(await request('/control', 'POST')),
    releaseComputerControl: async (leaseId) => {
      await request('/control', 'DELETE', { leaseId });
    },
    sendComputerInput: async (input) => {
      await request('/input', 'POST', input);
    },
    getComputerFrame: async () => ComputerFrameSchema.parse(await request('/frame')),
  };
}
