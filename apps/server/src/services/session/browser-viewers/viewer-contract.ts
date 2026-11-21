import type { BrowserViewerViewport } from '@dorkos/shared/browser-viewer-control';
import type {
  BrowserPageBinding,
  BrowserPageFacts,
  BrowserPersonInputLease,
} from '../local-browser/leases/broker-contract.js';
/** The authenticated person and app instance owning a viewer. Never supplied in JSON. */
export interface ViewerPrincipal {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly clientId: string;
}

/** A server-resolved page binding; no client chooses a tab or profile. */
export interface ViewerPageIdentity {
  readonly chatId: string;
  readonly profileId: string | null;
  readonly connectionId: string;
  readonly tabId: string;
}

/** One bounded JPEG produced by an owned page, with no URLs or page text. */
export interface ViewerFrame {
  readonly navigationGeneration: number;
  readonly controlEpoch: number;
  readonly viewport: BrowserViewerViewport;
  readonly sequence: number;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
}

/** The narrow read-only broker seam. It cannot launch, select, navigate or type. */
export interface ViewerPage {
  readonly binding: BrowserPageBinding;
  facts(): BrowserPageFacts;
  onChange(listener: () => void): () => void;
  takeControl(): Promise<BrowserPersonInputLease>;
  handBack(lease: BrowserPersonInputLease): Promise<void>;
  abandon(): Promise<void>;
  close(): Promise<void>;
  readonly identity: ViewerPageIdentity;
  /** Synchronous revocation of this exact page generation, including waiting deliveries. */
  readonly signal: AbortSignal;
  /** Final synchronous page-generation fence after the route's awaited session check. */
  assertLive(): void;
  /** Recheck ownership, profile access and page lifetime before every delivery. */
  assertCurrent(): Promise<void>;
  /** Attach one producer over the existing owned pipe; cleanup never closes the page. */
  start(receive: (frame: ViewerFrame) => void): Promise<() => Promise<void>>;
}

/** Resolve an existing page for a person's selected chat, without opening anything. */
export type ResolveViewerPage = (
  chatId: string,
  principal: ViewerPrincipal,
  viewerId: string
) => Promise<ViewerPage>;

/** A sent frame's opaque, one-use paint receipt. */
export interface DeliveredViewerFrame extends ViewerFrame {
  readonly receipt: string;
}

/** Production limits also exercised by fake-clock and fake-CDP tests. */
export const VIEWER_LIMITS = Object.freeze({
  frameBytes: 2 * 1024 * 1024,
  width: 1280,
  height: 960,
  viewers: 8,
  viewersPerPage: 3,
  idleMs: 5_000,
  pollMs: 2_000,
  lifetimeMs: 30 * 60_000,
  frameIntervalMs: 1_000 / 12,
  viewerBytesPerSecond: 512 * 1024,
  viewerBurstBytes: 2 * 1024 * 1024,
  installBytesPerSecond: 4 * 1024 * 1024,
});

/** Refusals contain only a fixed code, never an exception from Chrome or page content. */
export class BrowserViewerError extends Error {
  constructor(
    readonly code:
      | 'viewer_unavailable'
      | 'viewer_denied'
      | 'viewer_busy'
      | 'viewer_limit'
      | 'viewer_stale'
      | 'viewer_uncertain'
      | 'file_picker_stuck'
  ) {
    super(code);
  }
}
