/**
 * Workbench-serve domain — signed-URL static serving of local HTML and a
 * per-target preview origin for localhost dev servers (DOR-216, DOR-1260;
 * ADR 260708-185519).
 *
 * @module services/workbench-serve
 */
export {
  WorkbenchTokenSigner,
  WorkbenchTokenError,
  workbenchTokenSigner,
  type WorkbenchTokenScope,
  type WorkbenchTokenPayload,
  type WorkbenchTokenErrorCode,
} from './token.js';
export {
  PreviewListenerManager,
  PreviewPortExhaustedError,
  previewListeners,
  previewCookieName,
  rewriteUpstreamLocation,
  PREVIEW_BOOTSTRAP_PARAM,
  PREVIEW_HEALTH_PATH,
  type PreviewOrigin,
  type PreviewListenerOptions,
  type PreviewLogger,
} from './preview-listener.js';
export { stripFrameAncestors, isUtf8OrUnspecified } from './proxy-headers.js';
export { probeLoopbackPort } from './probe.js';
export { injectDevtoolsScript, DEVTOOLS_AGENT_SCRIPT } from './devtools-inject.js';
