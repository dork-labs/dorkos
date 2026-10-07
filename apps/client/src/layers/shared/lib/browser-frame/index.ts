/** Narrow bounded frame-body reader barrel; imports no HTTP transport or server authority. */
export { readBrowserFrameBody } from '../transport/browser-frame-body';
export { createBrowserViewerHttp, BROWSER_FRAME_CONTENT_TYPE } from './viewer-http';
export type { BrowserViewerHttpContextReader } from './viewer-http';
export { createBrowserInputHttp } from './input-http';
export type { BrowserInputHttpContextReader } from './input-http';
