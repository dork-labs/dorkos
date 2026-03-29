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

/** Tracks an active server-side extension instance. */
export interface ActiveServerExtension {
  extensionId: string;
  router: Router;
  cleanup: (() => void) | null;
  scheduledCleanups: Array<() => void>;
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
  phase?: 'compilation' | 'activation';
  contributions?: Record<ExtensionPointId, number>;
  errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
  error?: string;
  stack?: string;
  message?: string;
}

/** Strip server-internal fields from ExtensionRecord for client consumption. */
export function toPublic(record: ExtensionRecord): ExtensionRecordPublic {
  return {
    id: record.id,
    manifest: record.manifest,
    status: record.status,
    scope: record.scope,
    error: record.error,
    bundleReady: record.bundleReady,
    hasServerEntry: record.hasServerEntry,
    hasDataProxy: record.hasDataProxy,
  };
}
