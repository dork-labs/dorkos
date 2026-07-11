/**
 * Workbench-serve domain — signed-URL static serving of local HTML and a
 * localhost reverse-proxy for the embedded browser (DOR-216, ADR 260708-185519).
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
export { proxyToLocalhost, stripFrameAncestors } from './proxy.js';
export { injectDevtoolsScript, DEVTOOLS_AGENT_SCRIPT } from './devtools-inject.js';
