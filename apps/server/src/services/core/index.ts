/**
 * Core services — configuration, SSE streaming, file listing, git status,
 * OpenAPI registry, tunnel management, update checking, and file uploads.
 *
 * Claude Code-specific services live in `services/runtimes/claude-code/`.
 *
 * @module services/core
 */
export { configManager, initConfigManager } from './config-manager.js';
export { fileLister } from './file-lister.js';
export { getGitStatus, parsePorcelainOutput } from './git-status.js';
export { generateOpenAPISpec } from './openapi-registry.js';
export { initSSEStream, sendSSEEvent, endSSEStream } from './stream-adapter.js';
export { TunnelManager, tunnelManager } from './tunnel-manager.js';
export type { TunnelConfig } from './tunnel-manager.js';
export type { TunnelStatus } from '@dorkos/shared/types';
export { getLatestVersion, resetCache } from './update-checker.js';
export { uploadHandler } from './upload-handler.js';
