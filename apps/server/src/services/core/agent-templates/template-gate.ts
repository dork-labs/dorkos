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
 * DOR-2314 rule, which gains the git-directory refusal when DOR-2326 lands,
 * with no change here), and what its skills run (`readRunnableDeclarations`:
 * hooks, allowed tools, and the commands a skill's text runs, DOR-2327). Only
 * after a {@link TemplateGate} lets it through is the staged copy moved into
 * place, so nothing it carries runs before someone saw it.
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
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { findAgentWorkspaceConfig } from '@dorkos/marketplace/agent-workspace-config';
import {
  disclosesAnything,
  revealHiddenCharacters,
  type DisclosedEffects,
} from '@dorkos/shared/marketplace-schemas';
import { disclosedEffectsOf } from '../../marketplace/disclosed-effects.js';
import { packageContentHash } from '../../marketplace/lib/content-hash.js';
import { readRunnableDeclarations } from '../../marketplace/permission-preview.js';
import type {
  ConfirmationProvider,
  ConfirmationRequest,
  TemplateSettingsFileShown,
} from '../../marketplace-mcp/confirmation-provider.js';

/** One harness file a template carries into the agent's working directory. */
export interface TemplateFinding {
  /** Its path in the template. */
  path: string;
  /** One plain sentence about what it is. */
  message: string;
}

/**
 * One settings file a template carries, written out for the person deciding.
 * The content hash binds these bytes, so what is shown is what lands.
 */
type TemplateSettingsFile = TemplateSettingsFileShown;

/** What a staged template brings, read before it lands anywhere. */
export interface TemplateInspection {
  /** Where it was cloned from, as the caller named it. */
  source: string;
  /** The staged copy's content hash: what an approval of it binds. */
  contentHash: string;
  /** Harness configuration an agent package may not ship. */
  findings: TemplateFinding[];
  /** Every file under those findings, with its contents, for the review. */
  settings: TemplateSettingsFile[];
  /** What its skills run and may do without asking, in the disclosure shape. */
  disclosed: DisclosedEffects;
}

/** The longest settings file shown in full; a longer one is named, not cut. */
export const SETTINGS_FILE_MAX_BYTES = 32 * 1024;

/** The most files listed under one finding (a whole `.codex/` folder, say). */
const SETTINGS_FILES_MAX = 50;

/** C0 and C1 control characters other than tab and newline. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Show a file's text as it is, with nothing able to hide in it: every
 * invisible, direction-changing or control character (a carriage return
 * included, which can overwrite a line in a terminal) becomes a visible
 * `<U+XXXX>` marker.
 *
 * @param text - The file's text.
 * @returns The same text, safe to show a person deciding about it.
 */
export function showVerbatim(text: string): string {
  return revealHiddenCharacters(text.replace(/\r\n/g, '\n')).replace(
    CONTROL_CHARACTERS,
    (ch) => `<U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`
  );
}

/** Read one settings file for the review, never following a link. */
async function readSettingsFile(dir: string, rel: string): Promise<TemplateSettingsFile> {
  const abs = path.join(dir, ...rel.split('/'));
  const stat = await lstat(abs);
  if (stat.isSymbolicLink()) return { path: rel, bytes: 0, omitted: 'link' };
  if (stat.size > SETTINGS_FILE_MAX_BYTES) {
    return { path: rel, bytes: stat.size, omitted: 'too-long' };
  }
  const raw = await readFile(abs);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return { path: rel, bytes: stat.size, content: showVerbatim(text) };
  } catch {
    return { path: rel, bytes: stat.size, omitted: 'not-text' };
  }
}

/** Every file at or under `rel` (a finding may be a folder), links included but not followed. */
async function filesUnder(dir: string, rel: string): Promise<string[]> {
  const stat = await lstat(path.join(dir, ...rel.split('/'))).catch(() => undefined);
  if (!stat) return [];
  if (!stat.isDirectory()) return [rel];
  const found: string[] = [];
  const queue = [rel.replace(/\/+$/, '')];
  while (queue.length > 0 && found.length < SETTINGS_FILES_MAX) {
    const current = queue.shift()!;
    const entries = await readdir(path.join(dir, ...current.split('/')), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${current}/${entry.name}`;
      if (entry.isDirectory()) queue.push(child);
      else found.push(child);
    }
  }
  return found.slice(0, SETTINGS_FILES_MAX);
}

/**
 * Read every file the findings name, for the person to read before deciding.
 *
 * @param dir - The staging folder.
 * @param findings - The template's harness configuration.
 */
async function readSettings(
  dir: string,
  findings: readonly TemplateFinding[]
): Promise<TemplateSettingsFile[]> {
  const files: TemplateSettingsFile[] = [];
  for (const finding of findings) {
    for (const rel of await filesUnder(dir, finding.path)) {
      files.push(await readSettingsFile(dir, rel));
    }
  }
  return files;
}

/** What a tree brings into a folder sessions run in, apart from its hash. */
export interface TreeDisclosures {
  /** Harness configuration an agent package may not ship. */
  findings: TemplateFinding[];
  /** Every file under those findings, with its contents, for the review. */
  settings: TemplateSettingsFile[];
  /** What its skills run and may do without asking, in the disclosure shape. */
  disclosed: DisclosedEffects;
}

/**
 * Read what a tree brings into a folder sessions run in: its harness
 * configuration (`findAgentWorkspaceConfig`), each of those files written out,
 * and what its skills run (`readRunnableDeclarations`). Shared by the template
 * gate and the workspace clone gate (DOR-2335), which hash their trees
 * differently.
 *
 * @param dir - The tree, staged where no session runs.
 * @returns What it brings.
 */
export async function readTreeDisclosures(dir: string): Promise<TreeDisclosures> {
  const [findings, declared] = await Promise.all([
    findAgentWorkspaceConfig(dir),
    readRunnableDeclarations(dir, { agentWorkspace: true }),
  ]);
  // No schedules: a tree's scheduled skills arrive parked at
  // `pending_approval`, behind their own gate.
  const disclosed = disclosedEffectsOf({ ...declared, schedules: [] })!;
  const settings = await readSettings(dir, findings);
  return { findings, settings, disclosed };
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
  const [contentHash, tree] = await Promise.all([
    packageContentHash(dir),
    readTreeDisclosures(dir),
  ]);
  return { source, contentHash, ...tree };
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
      settings: inspection.settings,
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
