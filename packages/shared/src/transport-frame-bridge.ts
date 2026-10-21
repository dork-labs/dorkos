/**
 * Whether DorkOS added its frame scripts to a page the embedded browser opened,
 * and why not when it did not (DOR-3131). A slice of the `Transport`
 * (`transport-slices.ts`).
 *
 * @module shared/transport-frame-bridge
 */
import type { WorkbenchBridgeStatusRequest, WorkbenchBridgeStatusResponse } from './schemas.js';

/** Read the injection decision DorkOS recorded for one framed page. */
export interface FrameBridgeTransport {
  /**
   * What DorkOS decided the last time it served this page into a frame: the
   * scripts went in, they did not (with a stable reason), or it does not know.
   * Read after the frame's `load`, because the decision is made while serving.
   */
  getFrameBridgeStatus(
    target: WorkbenchBridgeStatusRequest
  ): Promise<WorkbenchBridgeStatusResponse>;
}
