import { randomBytes } from 'node:crypto';
import type {
  BrowserViewerChooser,
  BrowserViewerOperation,
  BrowserViewerOutcome,
  BrowserViewerViewport,
} from '@dorkos/shared/browser-viewer-control';
import type {
  BrowserPersonInputLease,
  BrowserPersonFile,
} from '../local-browser/leases/broker-contract.js';
import { LocalBrowserError } from '../local-browser/errors.js';
import { BrowserViewerError, type ViewerPage } from './viewer-contract.js';
import { ViewerControlQueue } from './control-queue.js';

interface Controller {
  id: string;
  lease: BrowserPersonInputLease;
  ending: boolean;
  nextSequence: number;
  painted?: { navigation: number; viewport: number; epoch: number };
  chooser?: BrowserViewerChooser;
  chooserExpires: number;
  offChooser: () => void;
  timer?: ReturnType<typeof setTimeout>;
  outcomes: Map<number, { at: number; outcome: BrowserViewerOutcome }>;
}
export interface ViewerControlResult {
  outcome: BrowserViewerOutcome;
  text?: string;
}
export interface ViewerControlContext {
  page: ViewerPage;
  queue: ViewerControlQueue;
  owner: string;
  uploads: Map<string, number>;
  enabled(): boolean;
  admit(): void;
  wake(): void;
  viewport(): BrowserViewerViewport | null;
}

/** Volatile controller authority and content-free outcomes; never caches copied text or inputs. */
export class ViewerControls {
  private control?: Controller;
  private preparing = false;
  constructor(private readonly context: ViewerControlContext) {}
  snapshot() {
    const c = this.active();
    return {
      control: c
        ? { id: c.id, epoch: c.lease.epoch, ready: this.ready(c), nextSequence: c.nextSequence }
        : null,
      chooser:
        c?.chooser &&
        Date.now() < c.chooserExpires &&
        c.chooser.navigationGeneration === this.context.page.facts().navigationGeneration
          ? c.chooser
          : null,
    };
  }
  async take(authorize: () => Promise<void>): Promise<void> {
    const h = this.context;
    h.admit();
    if (!h.enabled() || this.preparing || this.active())
      throw new BrowserViewerError('viewer_busy');
    this.preparing = true;
    try {
      await authorize();
      h.admit();
      if (!h.enabled()) throw new BrowserViewerError('viewer_denied');
      const lease = await h.page.takeControl();
      try {
        await authorize();
        h.admit();
        if (!h.enabled() || !lease.isCurrent()) throw new BrowserViewerError('viewer_stale');
        const c: Controller = {
          id: randomBytes(32).toString('base64url'),
          lease,
          ending: false,
          nextSequence: 1,
          chooserExpires: 0,
          offChooser: () => undefined,
          outcomes: new Map(),
        };
        this.control = c;
        c.offChooser = lease.onFileChooser((ticket) => {
          if (this.active() !== c) return;
          clearTimeout(c.timer);
          c.chooser = ticket;
          c.chooserExpires = Date.now() + 60_000;
          c.timer = setTimeout(() => {
            c.chooser = undefined;
            h.wake();
          }, 60_000);
          c.timer.unref?.();
          h.wake();
        });
      } catch (error) {
        await h.page.abandon().catch(() => undefined);
        throw error;
      }
    } finally {
      this.preparing = false;
      h.wake();
    }
  }
  paint(stamp: {
    navigationGeneration: number;
    addressGeneration: number;
    viewportGeneration: number;
    controlEpoch: number;
  }): void {
    const c = this.active();
    if (!c || c.lease.epoch !== stamp.controlEpoch) return;
    try {
      c.lease.confirmPaint(stamp);
      c.painted = {
        navigation: stamp.navigationGeneration,
        viewport: stamp.viewportGeneration,
        epoch: stamp.controlEpoch,
      };
    } catch {
      /* Pending safety or a replaced generation never grants input. */
    }
  }
  async end(
    id: string,
    epoch: number,
    resume: boolean,
    authorize: () => Promise<void>
  ): Promise<void> {
    const c = this.require(id, epoch);
    await authorize();
    this.require(id, epoch);
    c.ending = true;
    this.clear(c);
    this.context.wake();
    try {
      if (resume) await this.context.page.handBack(c.lease);
      else await this.context.page.abandon();
      if (this.control === c) this.control = undefined;
    } catch (error) {
      // Keep the failed controller addressable so explicit hand-back can report the typed refusal.
      c.ending = false;
      throw error;
    } finally {
      this.context.wake();
    }
  }
  disable(abandon = true): void {
    const c = this.control;
    if (!c) return;
    c.ending = true;
    this.clear(c);
    this.control = undefined;
    if (abandon) void this.context.page.abandon().catch(() => undefined);
    this.context.wake();
  }
  run(
    input: BrowserViewerOperation,
    effect: (lease: BrowserPersonInputLease, assertOperation: () => void) => Promise<string | void>,
    authorize: () => Promise<void>
  ): Promise<ViewerControlResult> {
    const c = this.require(input.controllerId, input.controlEpoch);
    this.assertOperation(c, input);
    const cached = c.outcomes.get(input.sequence);
    if (input.sequence < c.nextSequence && cached && Date.now() - cached.at < 300_000)
      return Promise.resolve({ outcome: cached.outcome });
    if (input.sequence !== c.nextSequence) throw new BrowserViewerError('viewer_stale');
    const result = this.context.queue.submit(async () => {
      try {
        this.assertOperation(c, input);
        await authorize();
        this.assertOperation(c, input);
        await this.context.page.assertCurrent();
        this.assertOperation(c, input);
        const text = await effect(c.lease, () => this.assertOperation(c, input));
        await authorize();
        this.assertOperation(c, input);
        return {
          outcome: this.remember(c, input.sequence, 'done'),
          ...(typeof text === 'string' ? { text } : {}),
        };
      } catch (error) {
        const code = controlCode(error);
        return {
          outcome: this.remember(
            c,
            input.sequence,
            code === 'viewer_uncertain' ? 'uncertain' : 'refused',
            code
          ),
        };
      } finally {
        this.context.wake();
      }
    });
    c.nextSequence++;
    return result.catch((error) => ({
      outcome: this.remember(c, input.sequence, 'refused', controlCode(error)),
    }));
  }
  files(
    input: BrowserViewerOperation,
    ticketId: string,
    read: () => Promise<BrowserPersonFile[]>,
    authorize: () => Promise<void>
  ): Promise<ViewerControlResult> {
    const c = this.operation(input);
    if (
      !c.chooser ||
      c.chooser.id !== ticketId ||
      Date.now() >= c.chooserExpires ||
      c.chooser.navigationGeneration !== input.navigationGeneration
    )
      throw new BrowserViewerError('viewer_stale');
    const h = this.context,
      count = h.uploads.get(h.owner) ?? 0;
    if (count >= 2) throw new BrowserViewerError('viewer_busy');
    h.uploads.set(h.owner, count + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (h.uploads.get(h.owner) ?? 1) - 1;
      if (n) h.uploads.set(h.owner, n);
      else h.uploads.delete(h.owner);
    };
    let effectStarted = false;
    try {
      const result = this.run(
        input,
        async (lease) => {
          effectStarted = true;
          let files: BrowserPersonFile[] = [],
            transferred = false;
          try {
            await authorize();
            this.assertOperation(c, input);
            files = await read();
            await authorize();
            this.assertOperation(c, input);
            transferred = true;
            await lease.chooseFiles(ticketId, files, release, () => this.assertOperation(c, input));
          } finally {
            if (!transferred) {
              for (const file of files) file.buffer.fill(0);
              release();
              await lease.cancelFileChooser(ticketId);
            }
          }
        },
        authorize
      );
      // A queue-age or admission refusal before the effect allocated nothing.
      c.chooser = undefined;
      clearTimeout(c.timer);
      this.context.wake();
      return result.finally(() => {
        if (!effectStarted) {
          release();
          void c.lease.cancelFileChooser(ticketId).catch(() => undefined);
        }
      });
    } catch (error) {
      release();
      throw error;
    }
  }
  cancel(id: string, epoch: number, ticket: string): Promise<void> {
    const c = this.require(id, epoch);
    if (c.chooser?.id !== ticket) throw new BrowserViewerError('viewer_stale');
    c.chooser = undefined;
    clearTimeout(c.timer);
    this.context.wake();
    return c.lease.cancelFileChooser(ticket);
  }
  private active(): Controller | undefined {
    const c = this.control;
    if (c && !c.ending && c.lease.isCurrent()) return c;
    if (c && !c.ending) {
      this.clear(c);
      this.control = undefined;
    }
    return undefined;
  }
  private require(id: string, epoch: number): Controller {
    this.context.admit();
    const c = this.active();
    if (!this.context.enabled() || !c || c.id !== id || c.lease.epoch !== epoch)
      throw new BrowserViewerError('viewer_denied');
    return c;
  }
  private ready(c: Controller): boolean {
    const facts = this.context.page.facts(),
      viewport = this.context.viewport();
    return (
      c.lease.inputReady() &&
      !!viewport &&
      c.painted?.navigation === facts.navigationGeneration &&
      c.painted.epoch === facts.controlEpoch &&
      c.painted.viewport === viewport.generation
    );
  }
  private operation(input: BrowserViewerOperation): Controller {
    const c = this.require(input.controllerId, input.controlEpoch);
    this.assertOperation(c, input);
    if (input.sequence !== c.nextSequence) throw new BrowserViewerError('viewer_stale');
    return c;
  }
  private assertOperation(c: Controller, input: BrowserViewerOperation): void {
    if (this.require(input.controllerId, input.controlEpoch) !== c || !this.ready(c))
      throw new BrowserViewerError('viewer_stale');
    const facts = this.context.page.facts(),
      viewport = this.context.viewport();
    if (
      facts.navigationGeneration !== input.navigationGeneration ||
      viewport?.generation !== input.viewportGeneration
    )
      throw new BrowserViewerError('viewer_stale');
  }
  private remember(
    c: Controller,
    sequence: number,
    status: BrowserViewerOutcome['status'],
    code?: BrowserViewerOutcome['code']
  ): BrowserViewerOutcome {
    const now = Date.now();
    for (const [key, value] of c.outcomes) if (now - value.at >= 300_000) c.outcomes.delete(key);
    while (c.outcomes.size >= 256) c.outcomes.delete(c.outcomes.keys().next().value!);
    const outcome = { sequence, status, ...(code ? { code } : {}) };
    c.outcomes.set(sequence, { at: now, outcome });
    return outcome;
  }
  private clear(c: Controller): void {
    c.offChooser();
    clearTimeout(c.timer);
    c.chooser = undefined;
    c.painted = undefined;
    c.outcomes.clear();
  }
}
/** Content-free transport codes; no page text or raw exception reaches an outcome. */
export function controlCode(error: unknown): NonNullable<BrowserViewerOutcome['code']> {
  if (error instanceof BrowserViewerError && error.code !== 'viewer_unavailable') return error.code;
  if (error instanceof LocalBrowserError) {
    if (error.code === 'uncertain') return 'viewer_uncertain';
    if (error.code === 'busy') return 'viewer_busy';
    if (error.code === 'file_picker_stuck') return 'file_picker_stuck';
  }
  return 'viewer_stale';
}
