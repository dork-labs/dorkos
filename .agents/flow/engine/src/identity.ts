/**
 * Identity & ownership model (§7) — the `/flow` engine's **one primitive, two
 * consumers**. {@link classifyOwnership} is the single function that decides who
 * owns a work item; its {@link OwnershipClass} result drives **both** dispatch
 * eligibility (§4, the {@link isClaimable} gate in `dispatch.ts`) and
 * comment-handling (§5, the rules in `comment-response.ts`). Those two modules
 * consume the class as an **injected input** — this module is what they inject.
 *
 * ## Governing principle (§7)
 *
 * Ownership/authorship live in **labels + a comment marker** (durable, always
 * present); a dedicated agent tracker account is a cleaner *enhancement* when it
 * exists. The engine therefore runs in one of two identity modes, **detected**
 * (never configured) from {@link Identity.reviewer}:
 *
 * - **Two-account (ideal)** — the agent ({@link Identity.agent}) and the human
 *   reviewer ({@link Identity.reviewer}) have **distinct** tracker accounts, so
 *   assignee + authorship are unambiguous and {@link classifyOwnership} can
 *   distinguish `mine` from `reviewer` purely from the assignee.
 * - **Shared-account (fallback)** — the agent acts *as* the human's account.
 *   `agent === reviewer`, so the assignee alone can no longer separate the two:
 *   a self-assignment is still {@link OwnershipClass | `mine`} (the agent's
 *   account is the assignee), but the **claim** must additionally carry the
 *   `agent/claimed` label — see {@link SHARED_MODE_CLAIM_LABEL}. The agent
 *   recognizes its own comments by {@link Identity.marker} and hands off by
 *   label + nudge. Mode detection: see {@link resolveIdentityMode}.
 *
 * ## Identity resolution (the `"auto"` contract)
 *
 * **No personal identity ships in the package** — the §9 defaults
 * (`identity.agent: "auto"`, `identity.reviewer: null`) resolve at runtime from
 * the installer's authenticated account via the adapter's `getCurrentUser`.
 * This module takes the **already-resolved** {@link Identity} as input: the
 * runtime resolves `"auto"` → the authenticated account id (and may resolve
 * `reviewer` from `null`) *before* calling {@link classifyOwnership}. This
 * module never reads config defaults or calls the adapter; it is pure.
 *
 * ## Scope — issues AND projects (§7, `ownership.scope`)
 *
 * The same primitive classifies an **issue** (via its `assignee`) and a
 * **project** (via its `project.lead`), honoring `ownership.scope:
 * ["issues","projects"]`. {@link classifyOwnership} selects the owner field by
 * the requested {@link OwnershipScope}.
 *
 * @see specs/unified-workflow-system/02-specification.md §7 (identity & ownership)
 * @see ./dispatch.ts ({@link isClaimable} — the dispatch consumer)
 * @see ./comment-response.ts (`shouldRespondToComment` — the comment consumer)
 * @module @dorkos/flow/identity
 */

import type { z } from 'zod';
import type { IdentitySchema, OwnershipScopeSchema } from './config-schema.js';
import type { OwnershipClass, WorkItem } from './work-item.js';

/**
 * The **resolved** agent identity (§7) — the runtime has already resolved
 * `identity.agent: "auto"` to the authenticated account id and (in two-account
 * mode) resolved {@link reviewer} from `null` to the human reviewer's account.
 * Structurally compatible with the inferred {@link IdentitySchema} config type,
 * but with {@link agent} narrowed to a concrete account id (never the literal
 * `"auto"` sentinel, which the runtime must resolve first).
 */
export interface Identity {
  /**
   * The resolved agent account id (the authenticated account; `identity.agent`
   * after `"auto"` resolution). Never the literal `"auto"` — resolving the
   * sentinel is the runtime's job, done before this module is called.
   */
  agent: string;
  /**
   * The resolved reviewer account id, or `null` when no distinct reviewer
   * account exists. `null` (or a value equal to {@link agent}) is what puts the
   * engine in **shared-account** mode — see {@link resolveIdentityMode}.
   */
  reviewer: string | null;
  /**
   * The durable authorship marker (`identity.marker`, default `"— 🤖 /flow"`)
   * the agent appends to tracker writes. In shared-account mode it is the only
   * signal that a comment is the agent's own; carried here so the resolved
   * identity is self-contained for both consumers.
   */
  marker: string;
}

/**
 * The detected identity mode (§7). **Detected, not configured** — derived from
 * {@link Identity.reviewer} by {@link resolveIdentityMode}.
 */
export type IdentityMode = 'two-account' | 'shared';

/** The ownership scope under classification — an issue's assignee or a project's lead. */
export type OwnershipScope = z.infer<typeof OwnershipScopeSchema>;

/** The inferred {@link IdentitySchema} config type (pre-`"auto"`-resolution). */
export type IdentityConfig = z.infer<typeof IdentitySchema>;

/**
 * The durable label a claim **must** carry in shared-account mode for an item on
 * the shared account to count as the agent's claimed work (§7). In shared mode
 * the assignee alone is ambiguous (agent and human are the same account), so the
 * dispatch/claim logic requires this label before treating a `mine`-classified
 * item as auto-claimable. {@link classifyOwnership} still returns `mine` for the
 * raw self-assignment; this constant documents the extra gate the **claim** step
 * enforces. Mirrors the `agent/claimed` value of `AgentDisposition`.
 */
export const SHARED_MODE_CLAIM_LABEL = 'agent/claimed';

/**
 * Detect the identity mode (§7) from the **resolved** {@link Identity}.
 *
 * The mode is *detected, never configured*: a missing, `null`, or
 * agent-equal {@link Identity.reviewer} means there is no distinct reviewer
 * account, so the agent is acting *as* the human — **shared** mode. A distinct
 * reviewer account ⇒ **two-account** mode.
 *
 * @param identity - The resolved agent identity (`agent`/`reviewer` resolved).
 * @returns `"shared"` when `reviewer` is unset/`null` or equals `agent`;
 *   otherwise `"two-account"`.
 */
export function resolveIdentityMode(identity: Identity): IdentityMode {
  if (identity.reviewer === null || identity.reviewer === identity.agent) {
    return 'shared';
  }
  return 'two-account';
}

/**
 * Resolve the owner account id for the requested {@link OwnershipScope}: an
 * issue's {@link WorkItem.assignee}, or — for `"projects"` — its
 * {@link WorkItem.project | project}'s `lead`. Returns `undefined` when the
 * owner is unset (unassigned issue, no project, or a project with no lead),
 * which {@link classifyOwnership} maps to the `unassigned` class.
 *
 * @param item - The work item under classification.
 * @param scope - Classify by issue `assignee` (`"issues"`) or project `lead`
 *   (`"projects"`).
 * @returns The owner account id, or `undefined` when unset.
 */
function ownerForScope(item: WorkItem, scope: OwnershipScope): string | undefined {
  return scope === 'projects' ? item.project?.lead : item.assignee;
}

/**
 * **The one primitive (§7).** Classify a work item's ownership by comparing its
 * owner — the issue {@link WorkItem.assignee} (`scope: "issues"`, the default)
 * or the {@link WorkItem.project | project} `lead` (`scope: "projects"`) —
 * against the **resolved** {@link Identity}. The resulting {@link OwnershipClass}
 * is consumed by **both** the dispatch eligibility gate ({@link isClaimable} in
 * `dispatch.ts`, §4) and the comment-response rules (`comment-response.ts`, §5).
 *
 * Classification:
 * - `mine` — owner is the {@link Identity.agent} account. Checked **first**, so
 *   in shared-account mode (`agent === reviewer`) a self-assignment classifies
 *   as `mine`, never `reviewer`.
 * - `reviewer` — owner is the distinct {@link Identity.reviewer} account
 *   (two-account mode only; in shared mode `reviewer === agent` already matched
 *   `mine`).
 * - `unassigned` — no owner (unset assignee, or a project with no/absent lead).
 * - `other` — owner is some third account (a teammate or another agent).
 *
 * ### Shared-account caveat — `mine` is not "auto-claimable"
 *
 * In shared mode this returns `mine` for any item on the shared account, but
 * that **does not** make the item auto-claimable: because agent and human share
 * the account, the dispatch/claim logic treats a `mine` item as the agent's
 * *own work to act on* only when it also carries the
 * {@link SHARED_MODE_CLAIM_LABEL | `agent/claimed`} label. This function reports
 * the raw ownership; the label gate lives in the claim step (it is intentionally
 * **not** folded in here, to keep the primitive a pure assignee-vs-identity
 * comparison that both consumers can rely on).
 *
 * @param item - The work item to classify.
 * @param identity - The resolved agent identity (`"auto"` already resolved).
 * @param scope - Which owner field to classify on; defaults to `"issues"`.
 * @returns The item's ownership class.
 */
export function classifyOwnership(
  item: WorkItem,
  identity: Identity,
  scope: OwnershipScope = 'issues'
): OwnershipClass {
  const owner = ownerForScope(item, scope);

  if (owner === undefined) return 'unassigned';
  // `agent` first: in shared mode (agent === reviewer) a self-assignment must
  // resolve to `mine`, not `reviewer`.
  if (owner === identity.agent) return 'mine';
  if (identity.reviewer !== null && owner === identity.reviewer) return 'reviewer';
  return 'other';
}
