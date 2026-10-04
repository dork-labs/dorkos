/**
 * Shared types and helpers for the extension manager system.
 *
 * @module services/extensions/extension-manager-types
 */
import type {
  ExtensionRecord,
  ExtensionRecordPublic,
  ExtensionPointId,
  ExtensionStatus,
  ExtensionToolStatus,
} from '@dorkos/extension-api';
import type { Router } from 'express';
import { mayRunExtensionCode, type ExtensionApprovals } from './extension-load-policy.js';
import type { RunningExtensionTools } from './agent-tools/tool-binding.js';

/** Tracks an active server-side extension instance. */
export interface ActiveServerExtension {
  extensionId: string;
  router: Router;
  cleanup: (() => void) | null;
  scheduledCleanups: Array<() => void>;
  /**
   * Removes every account usage listener and account advisor the extension
   * registered through `ctx.accounts`, and every project change listener it
   * added through `ctx.projects`, so a shutdown or reload never leaves one
   * behind even when the extension's own cleanup forgot it. Absent for a
   * proxy-only extension, which has no context.
   */
  releaseListeners?: () => void;
  /**
   * What this instance was built from — see `buildSourceKey` in
   * `extension-server-lifecycle.ts`. An `initialize` call carrying the same key
   * is answered without a restart, which is what keeps the client's per-page-load
   * init request from cycling every server-side extension.
   */
  sourceKey: string;
  /**
   * The tools this instance gives agents (DOR-2685): contributed to the
   * capability registry once it is active, and taken out first on shutdown.
   * Absent for a proxy-only extension, which binds no handlers.
   */
  agentTools?: RunningExtensionTools;
}

/**
 * Turn a compiler failure into the `error` a discovery record carries, so the
 * cockpit is told the same thing whichever compile produced it — the client
 * bundle's (`ExtensionManager`'s `applyCompileResult`) or the server entry's
 * ({@link ExtensionServerLifecycle.initialize}).
 *
 * @param error - The compiler's structured failure.
 */
export function toRecordError(error: {
  code: string;
  message: string;
  errors: Array<{ text: string }>;
}): NonNullable<ExtensionRecord['error']> {
  return {
    code: error.code,
    message: error.message,
    details: error.errors.map((e) => e.text).join('\n'),
  };
}

/** Result of creating a new extension. */
export interface CreateExtensionResult {
  id: string;
  path: string;
  scope: 'global' | 'local';
  template: string;
  status: ExtensionStatus;
  bundleReady: boolean;
  files: string[];
  error?: {
    code: string;
    message: string;
    errors?: Array<{
      text: string;
      location?: { file: string; line: number; column: number };
    }>;
  };
}

/** Result of reloading a single extension. */
export interface ReloadExtensionResult {
  id: string;
  status: ExtensionStatus;
  bundleReady: boolean;
  sourceHash?: string;
  error?: {
    code: string;
    message: string;
    errors?: Array<{
      text: string;
      location?: { file: string; line: number; column: number };
    }>;
  };
}

/** Result of headless extension testing via `testExtension()`. */
export interface TestExtensionResult {
  status: 'ok' | 'error';
  id: string;
  /**
   * Which step failed. `'approval'` is not a failure of the extension: it means a
   * person has not yet approved this extension to run code inside DorkOS
   * (`extension-load-policy.ts`), so the harness refused before evaluating the
   * bundle. Nothing about the code was executed.
   */
  phase?: 'approval' | 'compilation' | 'activation';
  /** Registrations per UI slot, plus `pages` for `registerPage`. */
  contributions?: Record<ExtensionPointId | 'pages', number>;
  errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
  error?: string;
  stack?: string;
  message?: string;
  /** Calls the real host would refuse, such as `registerComponent('dialog', …)`. Absent when none. */
  warnings?: string[];
}

/**
 * Strip server-internal fields from ExtensionRecord for client consumption.
 *
 * @param record - The internal discovery record.
 * @param approvals - `config.extensions` (the approved ids and the copy each is
 *   for), so the public record can carry the load-approval answer the cockpit
 *   renders. Passed in rather than read here to keep this module free of config
 *   I/O.
 * @param tools - Where each declared tool stands right now
 *   (`ExtensionServerLifecycle.toolStatuses`), when it declares any.
 */
export function toPublic(
  record: ExtensionRecord,
  approvals: ExtensionApprovals,
  tools?: ExtensionToolStatus[]
): ExtensionRecordPublic {
  return {
    id: record.id,
    manifest: record.manifest,
    status: record.status,
    scope: record.scope,
    origin: record.origin,
    ...(record.sourcePlugin ? { sourcePlugin: record.sourcePlugin } : {}),
    error: record.error,
    serverError: record.serverError,
    bundleReady: record.bundleReady,
    hasServerEntry: record.hasServerEntry,
    hasDataProxy: record.hasDataProxy,
    approvedToRun: mayRunExtensionCode(record, approvals),
    shadowedBy: record.shadowedBy ?? null,
    ...(record.originProblem ? { originProblem: record.originProblem } : {}),
    ...(record.devLink ? { devLink: { path: record.devLink.path } } : {}),
    ...(tools ? { tools } : {}),
  };
}
