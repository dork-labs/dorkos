/** Own context taken by a dispatch until the actual runtime invocation. */
import { randomUUID } from 'node:crypto';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { holdStagedContext, takeStagedContext } from '../staged-context-store.js';
import { restoreContextWarning } from '../agent-compaction/context-warning.js';
import { restoreTurnCutoff, type takeTurnCutoff } from '../turn-cutoff/turn-cutoff.js';
import { uiTurnFacts } from '../browser-seat/ui-turn-facts.js';

interface CleanupOwner {
  sessionId: string;
  turnKey: () => string;
  release: () => void;
  endSpan: () => void;
}

/** Restore taken notes once before an effect, or after a positive no-effect hold. */
export class DispatchContextCleanup {
  owedWarning: number | null = null;
  owedCutoff: ReturnType<typeof takeTurnCutoff> = null;
  settleNewSince: (delivered?: boolean) => void = () => {};
  runtimeAttempted = false;
  private staged: ReturnType<typeof takeStagedContext> = [];
  private cleaned = false;

  constructor(private readonly owner: CleanupOwner) {}

  /** Destructively take the real staged notes into this dispatch's context. */
  takeStaged(bag: AdditionalContext): void {
    this.staged = takeStagedContext(this.owner.sessionId);
    bag.push(...this.staged);
  }

  /** Finish the pre-effect attempt; an ambiguous runtime invocation never restores its notes. */
  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    const { sessionId, turnKey, release, endSpan } = this.owner;
    try {
      if (!this.runtimeAttempted) {
        for (const entry of this.staged)
          holdStagedContext(sessionId, entry.data.text, randomUUID());
        if (this.owedWarning !== null) restoreContextWarning(turnKey(), this.owedWarning);
        if (this.owedCutoff !== null) restoreTurnCutoff(turnKey(), this.owedCutoff);
        this.settleNewSince();
      }
    } finally {
      uiTurnFacts.endTurn(turnKey());
      release();
      endSpan();
    }
  }
}
