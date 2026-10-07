/** Browser metadata entity; no engine, process, profile-path, or credential imports. */
export { browserKeys } from './api/query-keys';
export type {
  BrowserViewer,
  BrowserProfile,
  BrowserInstance,
  BrowserCloseRequest,
  BrowserCloseReceipt,
} from './model/types';
export {
  useBrowserProfiles,
  useBrowserProfile,
  useBrowserInstances,
  useBrowserInstance,
  useCloseBrowserInstance,
} from './model/use-browser';

/** Disposable pixel rendering does not grant engine or server permission. */
export { BrowserPixelRenderer, BrowserPixelRenderRefusal } from './lib/pixel-renderer';
export type { BrowserPixelPresentation } from './lib/pixel-renderer';

/** Private viewer pumping is delivery/presentation plumbing, never server authority or a public mount. */
export { BrowserViewerPump, BrowserViewerPumpRefusal } from './lib/viewer-pump';
export type {
  BrowserViewerAdmission,
  BrowserViewerDeliveryPort,
  BrowserViewerContext,
} from './lib/viewer-pump';

export { BrowserCanvasInput, BrowserCanvasInputRefusal } from './lib/canvas-input';
export type { BrowserRenderedInputContext } from './lib/canvas-input';

export {
  SemanticOutlineSession,
  type SemanticOutlineState,
} from './model/semantic-outline-session';

export { CanvasSelectionCopy, type SelectionCopyPorts } from './lib/canvas-selection-copy';
