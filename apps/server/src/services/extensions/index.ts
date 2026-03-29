/**
 * Extension system services — discovery, compilation, and lifecycle management.
 *
 * @module services/extensions
 */
export { ExtensionDiscovery } from './extension-discovery.js';
export { ExtensionCompiler } from './extension-compiler.js';
export { ExtensionManager } from './extension-manager.js';
export type {
  CreateExtensionResult,
  ReloadExtensionResult,
  TestExtensionResult,
} from './extension-manager.js';
export { MockExtensionAPI } from './extension-test-harness.js';
export { createProxyRouter } from './extension-proxy.js';
export { createDataProviderContext } from './extension-server-api-factory.js';
