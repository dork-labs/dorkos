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
} from '@dorkos/extension-api';
import type { Router } from 'express';
import { mayRunExtensionCode } from './extension-load-policy.js';

/** Tracks an active server-side extension instance. */
export interface ActiveServerExtension {
  extensionId: string;
  router: Router;
  cleanup: (() => void) | null;
  scheduledCleanups: Array<() => void>;
  /**
   * What this instance was built from — see `buildSourceKey` in
   * `extension-server-lifecycle.ts`. An `initialize` call carrying the same key
   * is answered without a restart, which is what keeps the client's per-page-load
   * init request from cycling every server-side extension.
   */
  sourceKey: string;
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
  contributions?: Record<ExtensionPointId, number>;
  errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
  error?: string;
  stack?: string;
  message?: string;
}

/**
 * Strip server-internal fields from ExtensionRecord for client consumption.
 *
 * @param record - The internal discovery record.
 * @param approvedToRun - `config.extensions.approvedToRun`, so the public record
 *   can carry the load-approval answer the cockpit renders. Passed in rather than
 *   read here to keep this module free of config I/O.
 */
export function toPublic(
  record: ExtensionRecord,
  approvedToRun: readonly string[]
): ExtensionRecordPublic {
  return {
    id: record.id,
    manifest: record.manifest,
    status: record.status,
    scope: record.scope,
    origin: record.origin,
    error: record.error,
    bundleReady: record.bundleReady,
    hasServerEntry: record.hasServerEntry,
    hasDataProxy: record.hasDataProxy,
    approvedToRun: mayRunExtensionCode(record.id, record.origin, approvedToRun),
  };
}
