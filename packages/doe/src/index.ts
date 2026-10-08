/** Standalone host contracts and SQLite durability. Pi implementation remains internal. */
export type * from './contracts.js';
export { SqliteModelStore } from './store.js';

export { LocalResources } from './resources/resources.js';
export { CanonicalPaths, canonicalPath, contained } from './resources/paths.js';
export { createLocalTools, createSkillTool } from './tools/local.js';
export type { LocalToolOptions } from './tools/local.js';
export { createWebFetchTool } from './tools/web-fetch.js';
export type { WebFetchOptions } from './tools/web-fetch.js';
export {
  DeferredToolRegistry,
  INITIAL_SCHEMA_BUDGET_BYTES,
  createToolSearch,
  createDefaultToolRegistry,
  mcpAlias,
} from './registry/registry.js';
export type { ToolMetadata } from './registry/registry.js';
export { McpConnection, boundedMcpFetch } from './mcp/connection.js';
export type { McpTransportConfig, McpLimits } from './mcp/connection.js';

export { Doe } from './doe.js';
export { businessPrompt } from './prompt.js';
export type { Engine, EngineFactory, EngineRequest, EngineResult } from './engine.js';

export { createCompaction } from './compaction.js';
export type { CompactionOptions } from './compaction.js';

export { createBuilderTool, createBuilderShell, builderPrompt } from './builder.js';
export type { BuilderToolOptions } from './builder.js';
export { createBeatExtension, validateBeatOutcome } from './beat/beat.js';
export type { BeatOptions } from './beat/beat.js';
