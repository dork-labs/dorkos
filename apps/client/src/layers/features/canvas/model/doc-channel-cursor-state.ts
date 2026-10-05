/** Inert bounded replay cursor state. Recovery alone owns identity and dispatch decisions. */
import type { CanvasChannelFrame } from '@dorkos/shared/canvas-channel-schemas';

/** Retain bounded inert payload cursors and a scalar catch-up target across replay runs. */
export class DocChannelCursor {
  private contiguous = 0;
  private through = 0;
  private readonly pending = new Map<number, CanvasChannelFrame>();

  get highest(): number {
    return this.contiguous;
  }
  get catchUpThrough(): number {
    return this.through;
  }
  get pendingCount(): number {
    return this.pending.size;
  }

  reset(): void {
    this.contiguous = 0;
    this.through = 0;
    this.pending.clear();
  }

  /** A stale page reset can retain quarantined payload and the independent target. */
  resetHighest(): void {
    this.contiguous = 0;
  }

  advance(seq: number): void {
    this.contiguous = Math.max(this.contiguous, seq);
  }
  markThrough(seq: number): void {
    this.through = Math.max(this.through, seq);
  }

  /** Return payload eviction separately; its durable numeric target survives. */
  recordGap(frame: CanvasChannelFrame): boolean {
    this.markThrough(frame.docSeq);
    this.pending.set(frame.docSeq, frame);
    if (this.pending.size <= 200) return false;
    this.pending.clear();
    return true;
  }

  /** Never dispatch or batch: the caller rechecks its lifetime between each frame. */
  takeNextContiguous(): CanvasChannelFrame | undefined {
    for (const seq of this.pending.keys()) {
      if (seq <= this.contiguous) this.pending.delete(seq);
    }
    const next = this.contiguous + 1;
    const frame = this.pending.get(next);
    if (frame) this.pending.delete(next);
    return frame;
  }

  clearReachedTarget(): boolean {
    if (this.contiguous < this.through) return false;
    this.through = 0;
    return true;
  }
}
