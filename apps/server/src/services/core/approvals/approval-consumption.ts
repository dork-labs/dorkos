/** Genuine consumption settlements that can be published after a caller's SQLite transaction. */
import { approvals, eq, type Db } from '@dorkos/db';

/** Opaque identity returned only by an actual successful conditional consumption write. */
export interface ApprovalConsumptionSettlement {
  readonly approvalId: string;
  readonly outcome: 'consumed' | 'expired';
}
/** A transaction owner collects settlements and publishes them only after its commit succeeds. */
export interface ApprovalConsumeOptions {
  deferSettlement?: (settlement: ApprovalConsumptionSettlement) => void;
}

/** Process-private proof registry; neither an approval id nor a copied object can publish a verdict. */
export class ApprovalConsumptionPublisher {
  private readonly active = new Map<string, ApprovalConsumptionSettlement>();
  private readonly proofs = new WeakMap<
    ApprovalConsumptionSettlement,
    typeof approvals.$inferSelect
  >();
  /** Use the approval service's existing settlement publisher, keeping notification ownership central. */
  constructor(
    private readonly db: Db,
    private readonly settle: (id: string, outcome: ApprovalConsumptionSettlement['outcome']) => void
  ) {}
  /** Collect the actual consumed row, or retain immediate settlement for ordinary existing callers. */
  collect(
    approvalId: string,
    outcome: ApprovalConsumptionSettlement['outcome'],
    options?: ApprovalConsumeOptions
  ): void {
    const previous = this.active.get(approvalId);
    if (previous) this.discard(previous);
    if (!options?.deferSettlement) {
      this.settle(approvalId, outcome);
      return;
    }
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row?.consumedAt) throw new Error('Approval consumption has no persisted settlement.');
    const proof = Object.freeze({ approvalId, outcome });
    this.proofs.set(proof, row);
    this.active.set(approvalId, proof);
    options.deferSettlement(proof);
  }
  /** Retire a rolled-back or completed attempt without publishing any notification. */
  discard(proof: ApprovalConsumptionSettlement): void {
    this.proofs.delete(proof);
    if (this.active.get(proof.approvalId) === proof) this.active.delete(proof.approvalId);
  }
  /** Publish once, only outside a transaction and against the same actual committed consumption. */
  publish(proof: ApprovalConsumptionSettlement): boolean {
    const evidence = this.proofs.get(proof);
    if (!evidence || this.db.$client.inTransaction) return false;
    this.discard(proof);
    const row = this.db.select().from(approvals).where(eq(approvals.id, evidence.id)).get();
    if (
      !row?.consumedAt ||
      row.consumedAt !== evidence.consumedAt ||
      row.expiresAt !== evidence.expiresAt ||
      row.state !== evidence.state ||
      row.inputHash !== evidence.inputHash ||
      row.capabilityId !== evidence.capabilityId ||
      row.tokenHash !== evidence.tokenHash ||
      row.authorityBindingDigest !== evidence.authorityBindingDigest ||
      row.decidedAt !== evidence.decidedAt
    )
      return false;
    this.settle(evidence.id, proof.outcome);
    return true;
  }
}
