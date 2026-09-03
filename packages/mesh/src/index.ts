/**
 * @dorkos/mesh -- Agent discovery, registration, and registry for DorkOS.
 *
 * Provides pluggable discovery strategies, SQLite-backed persistence,
 * manifest management, and optional Relay integration.
 *
 * @module mesh
 */

// Main entry point
export { MeshCore } from './mesh-core.js';
export type { MeshOptions } from './mesh-core.js';

// Discovery
export type { DiscoveryStrategy } from './types.js';
export { unifiedScan } from './discovery/unified-scanner.js';
export type { RegistryLike, DenialListLike } from './discovery/unified-scanner.js';
export type { ScanEvent, ScanProgress, UnifiedScanOptions } from './discovery/types.js';
// What `MeshCore.onAgentAdopted` hands its callbacks — the server's agent-created
// seam takes exactly this shape (DOR-1042).
export type { AdoptedAgent } from './mesh-discovery.js';
export { UNIFIED_EXCLUDE_PATTERNS } from './discovery/types.js';

// Strategies
export { ClaudeCodeStrategy } from './strategies/claude-code-strategy.js';
export { CursorStrategy } from './strategies/cursor-strategy.js';
export { CodexStrategy } from './strategies/codex-strategy.js';
export { WindsurfStrategy } from './strategies/windsurf-strategy.js';
export { GeminiStrategy } from './strategies/gemini-strategy.js';
export { ClineStrategy } from './strategies/cline-strategy.js';
export { RooCodeStrategy } from './strategies/roo-code-strategy.js';
export { CopilotStrategy } from './strategies/copilot-strategy.js';
export { AmazonQStrategy } from './strategies/amazon-q-strategy.js';
export { ContinueStrategy } from './strategies/continue-strategy.js';

// Persistence
export { AgentRegistry } from './agent-registry.js';
export type { AgentRegistryEntry } from './agent-registry.js';

// The strip every public agent listing goes through — `projectPath`, `namespace`
// and `scanRoot` never leave this package. Exported so a consumer that has to
// assert what production ACTUALLY carries can run a real registry entry through
// the real strip, instead of hand-writing a fixture that quietly claims a field
// the wire never has (`GET /api/team`, DOR-971).
export { toManifest, ManifestUnreadableError } from './mesh-agent-management.js';
export { DenialList } from './denial-list.js';

// Manifest
export { readManifest, writeManifest, removeManifest } from './manifest.js';

// The contract that stopped collapsing a refused duplicate manifest into
// "there is nothing here" (ADR 260801-003050). Only this one leaves the
// package: `UpsertResult`, `AutoImportResult` and `ManifestProbe` are internal
// steps on the way to it, and the server's three MeshCore-shaped interfaces
// need this one to stay honest.
export type { SyncFromDiskResult } from './mesh-agent-management.js';

// Namespace
export { resolveNamespace, normalizeNamespace, validateNamespace } from './namespace-resolver.js';

// Topology
export { TopologyManager } from './topology.js';
export type { TopologyView, NamespaceInfo, CrossNamespaceRule } from './topology.js';

// Health
export {
  computeHealthStatus,
  ACTIVE_THRESHOLD_MINUTES,
  INACTIVE_THRESHOLD_MINUTES,
} from './health.js';

// Reconciler
export { reconcile } from './reconciler.js';
export type { ReconcileResult, ReconcilerDeps } from './reconciler.js';

// Relay Bridge
export { RelayBridge, subjectForAgent } from './relay-bridge.js';
export { NamespaceRuleStore } from './namespace-rule-store.js';
export type { NamespaceRule, NamespaceRuleStoreLike } from './namespace-rule-store.js';
