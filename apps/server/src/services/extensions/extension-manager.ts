import type { Router } from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';

import { type CoreExtensionInfo } from './extension-enable-resolution.js';

import { ExtensionCompiler } from './extension-compiler.js';

import type { ExtensionTemplate } from './extension-templates.js';
import {
  type CreateExtensionResult,
  type ReloadExtensionResult,
  type TestExtensionResult,
} from './extension-manager-types.js';

import { logger } from '../../lib/logger.js';

import * as scan from './manager/scan.js';
import * as commands from './manager/commands.js';
import * as approvals from './manager/approvals.js';
import * as publication from './manager/publication.js';
import { createManagerState, type ManagerState } from './manager/state.js';
import type { ExpectedCopy, DismissApprovalRefusal } from './manager/approvals.js';
export {
  isExpectedCopy,
  type ExpectedCopy,
  type DismissApprovalRefusal,
} from './manager/approvals.js';
export type { CreateExtensionResult, ReloadExtensionResult, TestExtensionResult };
/** Public facade owns one live state and one serialized publication queue. */
export class ExtensionManager {
  readonly dorkHome: string;
  private readonly state: ManagerState;
  constructor(
    dorkHome: string,
    coreExtensions: CoreExtensionInfo[] = [],
    options: { registerTimeoutMs?: number } = {}
  ) {
    this.dorkHome = dorkHome;
    this.state = createManagerState({
      dorkHome,
      coreExtensions,
      options,
      operations: {
        readPublic: (...args) => publication.readPublic(this.state, ...args),
        bindUnsourcedApprovals: (...args) => approvals.bindUnsourcedApprovals(this.state, ...args),
        reload: (...args) => scan.reload(this.state, ...args),
        requestRefresh: (...args) => scan.requestRefresh(this.state, ...args),
        placeSnapshots: (...args) => scan.placeSnapshots(this.state, ...args),
        needsServer: (...args) => scan.needsServer(this.state, ...args),
        enqueue: (job) => this.enqueue(job),
        emitChanged: () => this.emitChanged(),
      },
    });
  }
  getCompiler(): ExtensionCompiler {
    return this.state.compiler;
  }

  async initialize(cwd: string | null): Promise<void> {
    return scan.initialize(this.state, cwd);
  }

  async reload(): Promise<ExtensionRecordPublic[]> {
    return scan.reload(this.state);
  }

  requestRefresh(): void {
    return scan.requestRefresh(this.state);
  }

  async readPublic(options: { includeShadowed?: boolean } = {}): Promise<ExtensionRecordPublic[]> {
    return publication.readPublic(this.state, options);
  }

  whenIdle(): Promise<void> {
    return this.state.scans.then(
      () => undefined,
      () => undefined
    );
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.state.scans.then(job, job);
    this.state.scans = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  followProjects(
    source: {
      roots: (cwd: string | null) => Promise<readonly string[]>;
      onChange: (listener: () => void) => () => void;
    },
    options: { debounceMs?: number; announce?: (ids: string[]) => void } = {}
  ): () => void {
    return scan.followProjects(this.state, source, options);
  }

  onChange(listener: () => void): () => void {
    this.state.changeListeners.add(listener);
    return () => {
      this.state.changeListeners.delete(listener);
    };
  }

  listRecords(): ExtensionRecord[] {
    return Array.from(this.state.extensions.values());
  }

  private emitChanged(): void {
    for (const listener of this.state.changeListeners) {
      try {
        listener();
      } catch (err) {
        logger.warn('[Extensions] A change listener threw', err);
      }
    }
  }

  async reloadExtension(id: string): Promise<ReloadExtensionResult> {
    return commands.reloadExtension(this.state, id);
  }

  async testExtension(id: string): Promise<TestExtensionResult> {
    return commands.testExtension(this.state, id);
  }

  async testServerCompilation(id: string): Promise<string | null> {
    return commands.testServerCompilation(this.state, id);
  }

  async createExtension(options: {
    name: string;
    description?: string;
    template: ExtensionTemplate;
    scope: 'global' | 'local';
  }): Promise<CreateExtensionResult> {
    return commands.createExtension(this.state, options);
  }

  listPublic(): ExtensionRecordPublic[] {
    return publication.listPublic(this.state);
  }

  listShadowedPublic(): ExtensionRecordPublic[] {
    return publication.listShadowedPublic(this.state);
  }

  async trustSource(source: string): Promise<'added' | 'already' | 'unproven'> {
    return approvals.trustSource(this.state, source);
  }

  async untrustSource(source: string): Promise<boolean> {
    return approvals.untrustSource(this.state, source);
  }

  trustOfferFor(id: string): string | null {
    return approvals.trustOfferFor(this.state, id);
  }

  get(id: string): ExtensionRecord | undefined {
    return this.state.extensions.get(id);
  }

  async enable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    return commands.enable(this.state, id);
  }

  async disable(
    id: string
  ): Promise<{ extension: ExtensionRecordPublic; reloadRequired: boolean } | null> {
    return commands.disable(this.state, id);
  }

  async approveToRun(id: string): Promise<ExtensionRecordPublic | null> {
    return approvals.approveToRun(this.state, id);
  }

  dismissApproval(
    id: string,
    expected: ExpectedCopy
  ): { ok: true } | { ok: false; reason: DismissApprovalRefusal } {
    return approvals.dismissApproval(this.state, id, expected);
  }

  async revokeRunApproval(id: string): Promise<ExtensionRecordPublic | null> {
    return approvals.revokeRunApproval(this.state, id);
  }

  async forgetRunApproval(id: string, installRoot?: string): Promise<void> {
    return approvals.forgetRunApproval(this.state, id, installRoot);
  }

  async initializeServer(id: string): Promise<{ ok: boolean; error?: string }> {
    const record = this.state.extensions.get(id);
    if (!record) return { ok: false, error: 'Extension not found' };
    return this.state.serverLifecycle.initialize(id, record);
  }

  async shutdownServer(id: string): Promise<void> {
    return this.state.serverLifecycle.shutdown(id);
  }

  getServerRouter(id: string): Router | null {
    return this.state.serverLifecycle.getRouter(id);
  }

  async readBundle(id: string, expectedGeneration: string): Promise<string | null> {
    return publication.readBundle(this.state, id, expectedGeneration);
  }

  reportActivated(id: string): void {
    return publication.reportActivated(this.state, id);
  }

  reportActivateError(id: string, error: string): void {
    return publication.reportActivateError(this.state, id, error);
  }

  async updateCwd(newCwd: string | null): Promise<{ added: string[]; removed: string[] }> {
    return scan.updateCwd(this.state, newCwd);
  }
}
