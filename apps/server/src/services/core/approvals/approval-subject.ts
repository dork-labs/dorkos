/**
 * Turning the opaque id on an approval card into the name of a real thing
 * (DOR-1929).
 *
 * ## The defect this closes
 *
 * A person was asked to approve four irreversible deletions that read, in full,
 * `mesh_unregister … with agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"`. Every safety
 * property of the summary pipeline held — the value was quoted, capped, and
 * swept for secrets (`approval-summary.ts`) — and the card was still unanswerable,
 * because none of those properties makes a ULID mean anything. Hardening the
 * rendering was never the missing piece; naming the subject is.
 *
 * ## Why this is a seam and not a lookup at the render site
 *
 * {@link enforceCapabilityTier} is SYNCHRONOUS, and every registry that could
 * answer "what is this id called" is either async or service-bound. So the
 * resolution cannot happen inside the gate, and it must not happen in the
 * client, which never sees a tool's arguments at all — it renders a sentence the
 * server already composed.
 *
 * It happens one step earlier instead, in the async wrapper that already awaits
 * the caller's identity (`mcp-tool-gate.ts`), and the resolved subject is handed
 * to the gate as data. That is the same shape `resolveContext` already has, for
 * the same reason.
 *
 * ## Fail closed means fail to the id, never to a blank
 *
 * Every failure here — no declaration, no id at the declared path, a non-string
 * id, no resolver wired, a resolver that throws, a registry that no longer holds
 * the id — returns `undefined`, and an undefined subject leaves the card exactly
 * as it was before this module existed: the raw id, in the summary, unresolved.
 * A person is never shown a heading with nothing under it, and never shown a
 * card that quietly dropped the one argument that decides what runs.
 *
 * ## The label is not caller input
 *
 * A resolver is handed the caller's id and reads the name from the registry that
 * owns it. It never reads a name the caller supplied. The strongest thing a
 * malicious caller can do is point at a different REAL object — and the card
 * shows the id beside the name precisely so that shows up.
 *
 * That is not the same as the name being trustworthy: an agent's `displayName`
 * comes from its own `agent.json`, so an agent CAN name itself "DorkBot" and be
 * labelled that here. The id beside it is the answer, and it is why
 * `ApprovalSubject.id` is required rather than optional.
 *
 * One honest limit on that claim: the id goes through the same secret sweep
 * everything broadcast does, so an id that is a run of 32+ hex characters is
 * replaced by `(hidden)` and stops being checkable. No id in play is that shape
 * — ULIDs are 26 characters of Crockford base32 — and publishing a live token to
 * every connected client is the worse failure, so the sweep wins. A future id
 * format that IS hex would need this reconsidered, not just re-tested.
 *
 * @module services/core/approvals/approval-subject
 */
import type { ApprovalSubject, ApprovalSubjectKind } from '@dorkos/shared/approval-schemas';

import {
  joinSummaryFields,
  readApprovalInputPath,
  renderRequesterLabel,
  summaryFields,
} from './approval-summary.js';

/**
 * What an action declares about the argument that names its target.
 *
 * Declared beside `approvalDisplayFields` rather than derived from it: a display
 * field is "show this to the person", which is a different question from "this
 * one IS the thing", and only the second can be resolved to a name.
 */
export interface ApprovalSubjectDeclaration {
  /** Dotted path to the id argument, addressed exactly as a display field is. */
  field: string;
  /** Which registry holds the name for that id. */
  kind: ApprovalSubjectKind;
}

/**
 * Reads one registry's own name for an id.
 *
 * Returns `undefined` for an id the registry does not hold, which is a normal
 * answer rather than an error — an agent can ask to delete something that is
 * already gone. A resolver may throw; the caller treats that the same way.
 */
export type ApprovalSubjectResolver = (
  id: string
) => string | undefined | Promise<string | undefined>;

/** The resolvers wired at boot, one per subject kind. */
export type ApprovalSubjectResolvers = Partial<
  Record<ApprovalSubjectKind, ApprovalSubjectResolver>
>;

let resolvers: ApprovalSubjectResolvers = {};

/**
 * Wire the registries that can name a subject.
 *
 * Called once at boot, where the services exist. Until it runs, and for any kind
 * it does not cover, {@link resolveApprovalSubject} resolves nothing — so an
 * unwired server shows the ids it always showed rather than failing a gated call.
 * Unwiring is a legibility regression, never a safety one, which is why this
 * fails soft where the tier gate itself fails hard.
 *
 * @param next - The resolvers to use, replacing any already wired.
 */
export function initApprovalSubjectResolvers(next: ApprovalSubjectResolvers): void {
  resolvers = next;
}

/**
 * Drop the wired resolvers. Test-only seam, mirroring `resetCapabilityTierGate`.
 */
export function resetApprovalSubjectResolvers(): void {
  resolvers = {};
}

/**
 * Name the thing an action would act on, or answer that it cannot.
 *
 * @param declaration - The action's subject declaration, when it has one.
 * @param input - The parsed input the approval binds to.
 * @returns The named subject, or `undefined` on every failure path.
 */
export async function resolveApprovalSubject(
  declaration: ApprovalSubjectDeclaration | undefined,
  input: unknown
): Promise<ApprovalSubject | undefined> {
  if (!declaration) return undefined;

  const raw = readApprovalInputPath(input, declaration.field);
  // A non-string id is a caller sending something the schema did not promise.
  // There is nothing to look up and nothing honest to render, so the summary's
  // own rendering of that value stands on its own.
  if (typeof raw !== 'string' || raw.length === 0) return undefined;

  const resolver = resolvers[declaration.kind];
  if (!resolver) return undefined;

  let label: string | undefined;
  try {
    label = await resolver(raw);
  } catch {
    // Naming a subject is a legibility side channel. A registry that is down
    // must never turn an answerable card into a failed tool call.
    return undefined;
  }
  if (!label) return undefined;

  return {
    kind: declaration.kind,
    // Capped and swept exactly as a requester's own display name is, and for the
    // identical reason: both are names an agent can choose for itself.
    label: renderRequesterLabel(label),
    id: renderRequesterLabel(raw),
  };
}

/**
 * The two fields {@link describeRemainingArguments} reads off an action.
 *
 * Structural rather than an import of `GatedAction`, so the approvals module
 * stays free of any dependency on the capabilities module it is imported BY.
 */
export interface SubjectBearingAction {
  /** The action's declared display fields, in their declared order. */
  approvalDisplayFields?: readonly string[];
  /** Which argument names the target, when the action declares one. */
  approvalSubject?: ApprovalSubjectDeclaration;
}

/**
 * The arguments a CARD still has to say, once it has drawn the subject itself.
 *
 * The counterpart to `describeGatedAttempt`, and the split is the whole point. A
 * notification or an Activity row gets one self-contained sentence, because
 * nothing around them supplies the missing half. A card already draws the title
 * as its heading, the requester on its own line, and — once one resolves — the
 * subject in bold; repeating the sentence underneath then says the title twice
 * and the name twice, in the one place a person is trying to decide something.
 *
 * This is what is LEFT: every declared display field except the subject's,
 * rendered by the same capped, quoted, secret-swept renderer the sentence uses.
 * `undefined` when nothing remains, and the card then shows nothing rather than
 * repeating itself.
 *
 * Only meaningful when a subject actually resolved — the caller checks that.
 * Without one the card falls back to the full summary, which is the rendering
 * exactly as it was before subjects existed.
 *
 * @param action - The action's display-field and subject declarations.
 * @param input - The parsed input the approval binds to.
 * @returns The remaining arguments as one clause, or `undefined`.
 */
export function describeRemainingArguments(
  action: SubjectBearingAction,
  input: unknown
): string | undefined {
  const declared = action.approvalDisplayFields;
  return joinSummaryFields(
    summaryFields(input, declared).filter(
      (_pair, i) => declared?.[i] !== action.approvalSubject?.field
    )
  );
}
