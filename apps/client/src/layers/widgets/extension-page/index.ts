/**
 * Extension page widget — the route that renders an extension's page at
 * `/x/<extensionId>/<path>`, or says why there is none (spec
 * `flow-multiproject` §6.5).
 *
 * @module widgets/extension-page
 */
export { ExtensionPageRoute } from './ui/ExtensionPageRoute';
export { extensionPageState, type ExtensionPageState } from './model/extension-page-state';
export { createPageSearchWriter, pageSearchFrom } from './model/page-search';
