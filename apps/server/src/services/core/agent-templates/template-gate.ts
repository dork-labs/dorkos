/**
 * What a template brings, and who has to see it before an agent is created
 * from it (DOR-2325).
 *
 * A template is cloned into the new agent's folder, and that folder is where
 * the agent's sessions run. So a template can carry the same harness
 * configuration an agent package can (`.claude/settings.json` hooks and allow
 * rules, a root `.mcp.json`, Codex and OpenCode config), plus skills whose
 * hooks and allowed tools apply in those sessions. None of it used to be shown
 * or checked.
 *
 * ## The rule
 *
 * A template is cloned ONCE, into a staging folder outside the agent's folder,
 * and {@link inspectTemplate} reads it there: its content hash, the harness
 * configuration an agent package may not ship (`findAgentWorkspaceConfig`, the
 * DOR-2314 rule, which gains the git-directory refusal when DOR-2326 lands),
 * and what its skills run (`readRunnableDeclarations`, which gains skill-text
 * commands when DOR-2327 lands, so this path picks both up with no change
 * here). Only after a {@link TemplateGate} lets it through is the staged copy
 * moved into place, so nothing it carries runs before someone saw it.
 *
 * Who decides depends on who asked:
 *
 * - **A person** ({@link personTemplateGate}) is SHOWN a template that brings
 *   anything and creates the agent knowingly: the first request answers
 *   {@link TemplateNeedsReviewError} with the inspection, and the retry carries
 *   the content hash it was shown. Their own template is theirs to use, so it
 *   is disclosed, not refused.
 * - **Anyone else** (an agent) ({@link cardTemplateGate}) always gets an
 *   approval card listing everything the template brings, bound to its bytes
 *   and the folder it lands in. An agent may not create another agent whose
 *   sessions run a template's hooks without a person seeing them.
 *
 * `createAgentWorkspace` refuses a template with no gate at all, so no caller
 * can skip this by forgetting it.
 *
 * @module services/core/agent-templates/template-gate
 */
import { findAgentWorkspaceConfig } from '@dorkos/marketplace/agent-workspace-config';
import { disclosesAnything, type DisclosedEffects } from '@dorkos/shared/marketplace-schemas';
import { disclosedEffectsOf } from '../../marketplace/disclosed-effects.js';
import { packageContentHash } from '../../marketplace/lib/content-hash.js';
import { readRunnableDeclarations } from '../../marketplace/permission-preview.js';
import type {
  ConfirmationProvider,
  ConfirmationRequest,
} from '../../marketplace-mcp/confirmation-provider.js';

/** One harness file a template carries into the agent's working directory. */
export interface TemplateFinding {
  /** Its path in the template. */
  path: string;
  /** One plain sentence about what it is. */
  message: string;
}

/** What a staged template brings, read before it lands anywhere. */
export interface TemplateInspection {
  /** Where it was cloned from, as the caller named it. */
  source: string;
  /** The staged copy's content hash: what an approval of it binds. */
  contentHash: string;
  /** Harness configuration an agent package may not ship. */
  findings: TemplateFinding[];
  /** What its skills run and may do without asking, in the disclosure shape. */
  disclosed: DisclosedEffects;
}

/**
 * Read a staged template: its hash, its harness configuration and what its
 * skills run.
 *
 * @param source - Where it was cloned from.
 * @param dir - The staging folder holding the clone.
 * @returns The inspection.
 */
export async function inspectTemplate(source: string, dir: string): Promise<TemplateInspection> {
  const [contentHash, findings, declared] = await Promise.all([
    packageContentHash(dir),
    findAgentWorkspaceConfig(dir),
    readRunnableDeclarations(dir, { agentWorkspace: true }),
  ]);
  // No schedules: a template's scheduled skills arrive parked at
  // `pending_approval`, behind their own gate.
  const disclosed = disclosedEffectsOf({ ...declared, schedules: [] })!;
  return { source, contentHash, findings, disclosed };
}

/**
 * Whether a template brings anything a person has to see: harness
 * configuration, or skills that run programs or use tools without asking.
 *
 * @param inspection - The template's inspection.
 */
export function templateBringsAnything(inspection: TemplateInspection): boolean {
  return inspection.findings.length > 0 || disclosesAnything(inspection.disclosed);
}

/**
 * Decides whether an inspected template may land. Resolves to let it through;
 * throws one of the errors below to stop, having written nothing.
 */
export type TemplateGate = (inspection: TemplateInspection) => Promise<void>;

/** A person has to see what the template brings first (409). */
export class TemplateNeedsReviewError extends Error {
  /** Machine-readable code on the response. */
  readonly code = 'template_needs_review';
  /**
   * Build the error.
   *
   * @param inspection - What the template brings, for the caller to show.
   */
  constructor(readonly inspection: TemplateInspection) {
    super(
      'This template brings settings or programs that will run in the new agent’s sessions. ' +
        'Look at them, then create the agent again with the content hash you were shown.'
    );
    this.name = 'TemplateNeedsReviewError';
  }
}

/** A card is waiting for a person (202). */
export class TemplateApprovalPendingError extends Error {
  /** Machine-readable status on the response. */
  readonly status = 'requires_confirmation';
  /**
   * Build the error.
   *
   * @param token - The token to retry with once a person approved.
   * @param inspection - What the card shows.
   * @param reason - Why a second card appeared, when this replaced a stale one.
   */
  constructor(
    readonly token: string,
    readonly inspection: TemplateInspection,
    readonly reason?: string
  ) {
    super(
      'A person has to approve creating an agent from this template. Tell them an approval card ' +
        'is waiting, then retry with the same arguments and this confirmationToken.'
    );
    this.name = 'TemplateApprovalPendingError';
  }
}

/** A person turned it down, or nobody can be asked (403). */
export class TemplateDeclinedError extends Error {
  /**
   * Build the error.
   *
   * @param message - One plain sentence saying why.
   */
  constructor(message: string) {
    super(message);
    this.name = 'TemplateDeclinedError';
  }
}

/**
 * The gate for a person creating an agent: a template that brings nothing
 * lands; one that brings anything lands only when the caller sends back the
 * content hash it was shown.
 *
 * @param approvedContentHash - The hash the person was shown, on the retry.
 */
export function personTemplateGate(approvedContentHash?: string): TemplateGate {
  return async (inspection) => {
    if (!templateBringsAnything(inspection)) return;
    if (approvedContentHash !== undefined && approvedContentHash === inspection.contentHash) return;
    throw new TemplateNeedsReviewError(inspection);
  };
}

/** What {@link cardTemplateGate} binds its card to, beyond the template itself. */
export interface CardTemplateGateOptions {
  /** The approval primitive's provider; absent when marketplace approvals are off. */
  provider: ConfirmationProvider | undefined;
  /** The agent being created. */
  agentName: string;
  /** Where it lands. */
  directory: string;
  /** The token from an earlier `requires_confirmation`, on the retry. */
  confirmationToken?: string;
  /** Who asked, for the card. */
  requestedBy?: string;
}

/**
 * The request a template card is raised for and resolved against. Bound to
 * the agent's name, the folder it lands in, the template's bytes and what its
 * skills run (`bindingOf` in the confirmation provider).
 */
function cardRequestOf(
  opts: CardTemplateGateOptions,
  inspection: TemplateInspection
): ConfirmationRequest {
  return {
    packageName: opts.agentName,
    operation: 'create-agent-from-template',
    projectPath: opts.directory,
    contentHash: inspection.contentHash,
    templateDisclosure: {
      disclosed: inspection.disclosed,
      findings: inspection.findings.map((f) => f.path),
    },
    origin: { source: inspection.source },
    ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
  };
}

/**
 * The gate for anyone who is not a person at this machine: always an approval
 * card, listing everything the template brings, whether or not it brings
 * anything (its instructions shape the new agent too).
 *
 * @param opts - The provider and what the card binds.
 */
export function cardTemplateGate(opts: CardTemplateGateOptions): TemplateGate {
  return async (inspection) => {
    if (!opts.provider) {
      throw new TemplateDeclinedError(
        'Creating an agent from a template needs a person’s approval, and approvals are not ' +
          'available on this server right now.'
      );
    }
    const request = cardRequestOf(opts, inspection);
    const answer = opts.confirmationToken
      ? await opts.provider.resolveToken(opts.confirmationToken, request)
      : await opts.provider.requestInstallConfirmation(request);
    if (answer.status === 'approved') return;
    if (answer.status === 'pending') {
      throw new TemplateApprovalPendingError(answer.token, inspection, answer.reason);
    }
    throw new TemplateDeclinedError(
      answer.reason ?? 'A person turned down creating an agent from this template.'
    );
  };
}
