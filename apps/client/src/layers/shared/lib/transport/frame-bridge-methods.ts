/**
 * Whether DorkOS added its frame scripts to a page in the embedded browser
 * (DOR-3131).
 *
 * @module shared/lib/transport/frame-bridge-methods
 */
import type {
  WorkbenchBridgeStatusRequest,
  WorkbenchBridgeStatusResponse,
} from '@dorkos/shared/schemas';
import { fetchJSON } from './http-client';

/** Create the frame-bridge methods bound to a base URL. */
export function createFrameBridgeMethods(baseUrl: string) {
  return {
    /** What DorkOS decided the last time it served this page into a frame. */
    getFrameBridgeStatus(
      target: WorkbenchBridgeStatusRequest
    ): Promise<WorkbenchBridgeStatusResponse> {
      return fetchJSON<WorkbenchBridgeStatusResponse>(baseUrl, '/workbench/bridge', {
        method: 'POST',
        body: JSON.stringify(target),
      });
    },
  };
}
