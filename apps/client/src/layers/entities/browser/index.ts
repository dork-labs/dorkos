/** Browser metadata entity; no engine, process, profile-path, or credential imports. */
export { browserKeys } from './api/query-keys';
export type {
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
