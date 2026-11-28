/**
 * Whether DorkOS added its frame scripts to a page in the embedded browser
 * (DOR-3131), through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/frame-bridge-methods
 */
import type {
  WorkbenchBridgeStatusRequest,
  WorkbenchBridgeStatusResponse,
} from '@dorkos/shared/schemas';
import { createTransportApiClient } from './api-client';

/** Create the frame-bridge methods bound to a base URL. */
export function createFrameBridgeMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    /** What DorkOS decided the last time it served this page into a frame. */
    getFrameBridgeStatus(
      target: WorkbenchBridgeStatusRequest
    ): Promise<WorkbenchBridgeStatusResponse> {
      return api.call('workbench.createBridge', { body: target });
    },
  };
}
