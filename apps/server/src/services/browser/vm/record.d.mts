import type { VMDiagnosticsOwner } from './diagnostics.mjs';
type DiagnosticSummary = ReturnType<BrowserLifecycleEngine['diagnostics']>;
import type {
  BrowserBinding,
  BrowserCommand,
  BrowserCapture,
  BrowserLifecycleEngine,
} from '@dorkos/browser';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
export interface VMTab {
  binding: BrowserBinding;
  captureSequence: number;
  diagnostics: VMDiagnosticsOwner;
  pointer: null | Readonly<{ x: number; y: number; revision: number }>;
  pointerRevision?: number;
  keys: Set<string>;
  buttons: Set<'left' | 'middle' | 'right'>;
  buttonAnchors: Map<string, Readonly<{ x: number; y: number; revision: number }>>;
  composing: boolean;
  inputEntered: boolean;
  safety?: Promise<unknown>;
  stopped: boolean;
  pending: boolean;
}
export interface VMRetirement {
  readonly firstCause: string;
  readonly cleanup: Readonly<{
    state: 'unverified';
    coverage: 'unavailable';
    pending: false;
    uncertainty: readonly string[];
  }>;
  readonly terminal: Readonly<{ cleanup: 'unverified'; reason: 'observationUnavailable' }>;
  readonly originalVMClosure: unknown;
}
export interface VMTransport {
  semantic(action: string, tabId: string, fields?: Record<string, unknown>): Promise<unknown>;
  createTab(id: string): Promise<void>;
  capture(id: string): Promise<unknown>;
  navigate(id: string, url: string): Promise<void>;
  pointer(id: string, event: string, x: number, y: number, button: string): Promise<void>;
  wheel(id: string, x: number, y: number, dx: number, dy: number): Promise<void>;
  key(id: string, event: string, key: string, code: string): Promise<void>;
  text(id: string, text: string): Promise<void>;
  composition(id: string, text: string, start: number, end: number): Promise<void>;
  compositionCommit(id: string, text: string): Promise<void>;
  cancelComposition(id: string): Promise<void>;
  cancelDrag(id: string): Promise<void>;
  uploadStage(tabId: string, transfer: string, byteLength: number, sha256: string): Promise<void>;
  uploadChunk(tabId: string, transfer: string, sequence: number, bytes: Uint8Array): Promise<void>;
  uploadSeal(tabId: string, transfer: string): Promise<void>;
  uploadArm(tabId: string, transfer: string): Promise<void>;
  uploadComplete(tabId: string, transfer: string): Promise<void>;
  downloadArm(tabId: string, transfer: string): Promise<void>;
  transferSelection(
    tabId: string,
    transfer: string
  ): Promise<Readonly<{ name?: string; mimeType?: string; expectedBytes?: number }>>;
  downloadNext(
    tabId: string,
    transfer: string
  ): Promise<
    Readonly<{ bytes: Uint8Array; sequence: number; total: number; end: boolean; sha256?: string }>
  >;
  closeTransfer(tabId: string, transfer: string): Promise<void>;
  close(): Promise<unknown>;
}
export interface VMRecord {
  readonly browserId: string;
  readonly browserGeneration: number;
  readonly command: Extract<BrowserCommand, { kind: 'open' }>;
  readonly receiver: PrivateBrowserRetirementReceiver;
  guard(): void;
  ordinary(): boolean;
  own<T>(enter: () => T | PromiseLike<T>): Promise<T>;
  dispatch<T>(enter: () => T | PromiseLike<T>): Promise<T>;
  retire(cause: string): Promise<VMRetirement>;
  attachOriginalRuntimeSubject(token: unknown, release: unknown): void;
  installInitialNavigation(original: (value: unknown) => Promise<Readonly<BrowserBinding>>): void;
  attachOriginalSession(original: unknown): void;
  publishTab(): Promise<BrowserBinding>;
  exactTab(binding: BrowserBinding): VMTab;
  originalSession(): VMTransport;
  retainOriginalTransfer(owner: unknown): () => void;
  publishFrame(
    binding: BrowserBinding,
    raster: unknown,
    pointerBefore?: VMTab['pointer']
  ): BrowserCapture;
  neutralizeInput(tab: VMTab): Promise<BrowserBinding>;
  resetInput(binding: BrowserBinding): Promise<BrowserBinding>;
  diagnostics(binding: BrowserBinding): DiagnosticSummary;
  listTabs(): readonly BrowserBinding[];
}
export interface VMRecordOwner {
  issue(value: unknown): VMRecord;
  get(browserId: string, generation: number): VMRecord;
}
export function createOriginalVMRecordOwner(): VMRecordOwner;
