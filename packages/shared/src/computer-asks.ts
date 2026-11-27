/**
 * The asks port (spec `computer-side-starts-alone` §5.7): how computer-side
 * code puts a consent card in front of a person, and how it reports a standing
 * decision it may make without one.
 *
 * The computer says what it wants to do and why ({@link AskRequest}). The
 * space side builds the card, waits for a person, writes the standing decision
 * itself (the hook, folder and repo consent lists and the pins
 * `folderConfigPinned` and `repoBaselinesPinned`), and returns only the answer
 * ({@link AskAnswer}). A decision that needs no card, such as an upgrade pin or
 * a person's own edit moving a pin, leaves the computer as a
 * {@link StandingDecision} the space side writes the same way. The computer
 * never writes the `harness` or `permissions` settings itself.
 *
 * Every payload here is plain data and parses with its schema, so the same
 * shapes can cross a wire later. The one in-process handle is the
 * {@link AskWatch} a card's wait calls; over a wire the computer withdraws the
 * ask itself instead.
 *
 * Unwired, the port fails closed: {@link UNWIRED_COMPUTER_ASKS} answers every
 * ask `unwired` (nobody was asked, so nothing is allowed) and records nothing,
 * which only ever means a person is asked again later.
 *
 * @module shared/computer-asks
 */
import { z } from 'zod';

// === The requests a card is built from ===

/** One hook a package would install: its event, matcher and command. */
const ProjectedHookSchema = z.strictObject({
  /** The Claude-format event that fires it. */
  event: z.string(),
  /** What the event is narrowed to, when one is declared. */
  matcher: z.string().optional(),
  /** The command exactly as it would be written into a harness's hook config. */
  command: z.string(),
});

/** A file a hook command runs and the sha256 of its bytes, `[path, hash]`. */
export const HookScriptPinSchema = z.tuple([z.string(), z.string()]).readonly();

/** One package's request to install shell commands into a project's harnesses. */
export const HookProjectionRequestSchema = z.strictObject({
  /** The project whose harness files would be written. */
  projectPath: z.string().min(1),
  /** The installed package that declared the hooks. */
  packageName: z.string().min(1),
  /** Each command, the event that fires it and the matcher that narrows it, sorted. */
  hooks: z.array(ProjectedHookSchema),
  /** The files the commands run, each with its sha256, sorted by path. */
  scripts: z.array(HookScriptPinSchema).readonly().optional(),
});

/** One package's request to install hooks, as a person is asked about it. */
export type HookProjectionRequest = z.infer<typeof HookProjectionRequestSchema>;

/** One agent's folder allow list, as a person is asked about it. */
export const FolderAllowRequestSchema = z.strictObject({
  /** The registered agent's id. */
  agentId: z.string().min(1),
  /** The agent's display name, for the card. */
  agentName: z.string(),
  /** The registered agent home the rules were read from. */
  home: z.string().min(1),
  /** The rules DorkOS would apply, in order (already judged). */
  rules: z.array(z.string()).readonly(),
  /** The rules behind the agent's current yes, when it had one: the card says what changed. */
  previousRules: z.array(z.string()).readonly().optional(),
  /** How many rules in the file DorkOS left out (wildcards, its own tools). */
  dropped: z.number().int().nonnegative().optional(),
});

/** One agent's folder allow list, as a person is asked about it. */
export type FolderAllowRequest = z.infer<typeof FolderAllowRequestSchema>;

/** The three parts an agent folder's pin is made of, in the order a card names them. */
export const FOLDER_CONFIG_PARTS = ['hooks', 'mcpJson', 'manifest'] as const;

/** One of {@link FOLDER_CONFIG_PARTS}. */
export type FolderConfigPart = (typeof FOLDER_CONFIG_PARTS)[number];

const FolderConfigPartSchema = z.enum(FOLDER_CONFIG_PARTS);

/** The per-part digests of one agent home's folder settings. */
export const FolderConfigDigestsSchema = z.strictObject({
  hooks: z.string(),
  mcpJson: z.string(),
  manifest: z.string(),
});

/** The per-part digests of one agent home's folder settings. */
export type FolderConfigDigests = Record<FolderConfigPart, string>;

/** One agent's folder settings, as a person is asked about them. */
export const FolderConfigRequestSchema = z.strictObject({
  /** The registered agent's id. */
  agentId: z.string().min(1),
  /** The agent's display name, for the card. */
  agentName: z.string(),
  /** The registered agent home the settings were read from. */
  home: z.string().min(1),
  /** The part digests of the state the card asks about. */
  digests: FolderConfigDigestsSchema,
  /** The parts that differ from the agent's last yes, in card order. */
  changed: z.array(FolderConfigPartSchema).readonly(),
  /** What those parts would run, for the card. Never sent to an agent. */
  detail: z.string().optional(),
});

/** One agent's folder settings, as a person is asked about them. */
export type FolderConfigRequest = z.infer<typeof FolderConfigRequestSchema>;

/** What a repo or worktree setting is. */
export const RepoConfigKindSchema = z.enum(['local', 'mcpJson', 'hooks']);

/** What a repo or worktree setting is. */
export type RepoConfigKind = z.infer<typeof RepoConfigKindSchema>;

/** The commit a repo was last compared against. */
export const RecordedBaselineSchema = z.strictObject({
  /** The ref it resolved from. */
  branch: z.string(),
  /** The commit. */
  sha: z.string(),
});

/** The commit a repo was last compared against. */
export type RecordedBaseline = z.infer<typeof RecordedBaselineSchema>;

/** Why a repo's default branch can't be trusted as it stands. */
export const UntrustedReasonSchema = z.enum([
  'not-a-repo',
  'no-default-branch',
  'first-seen',
  'moved',
  'hooks-moved',
]);

/** Why a repo's default branch can't be trusted as it stands. */
export type UntrustedReason = z.infer<typeof UntrustedReasonSchema>;

/** One repo setting, as a person is asked about it. */
export const RepoConfigRequestSchema = z.strictObject({
  /** Which setting. */
  kind: RepoConfigKindSchema,
  /** The content digest the card binds to. */
  digest: z.string().min(1),
  /** What changed, by name: files, or settings keys for local settings. */
  names: z.array(z.string()),
  /** The diff or content the card shows. */
  detail: z.string(),
  /** The worktree's folder. */
  cwd: z.string().min(1),
  /** The agent the turn runs as, if any. */
  agentName: z.string().optional(),
  /** Set when the default branch could not be confirmed: a yes trusts it from now on. */
  trust: z
    .strictObject({
      commonDir: z.string().min(1),
      baseline: RecordedBaselineSchema,
      reason: UntrustedReasonSchema.optional(),
    })
    .optional(),
});

/** One repo setting, as a person is asked about it. */
export type RepoConfigRequest = z.infer<typeof RepoConfigRequestSchema>;

// === The port's payloads ===

/** What the computer wants a person to decide, by kind. */
export const AskRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('hook_projection'),
    request: HookProjectionRequestSchema,
    /**
     * The package is in the project but DorkOS did not install it (or its
     * files changed since): the card is passive, never expires, and an open
     * one is reused rather than raised twice.
     */
    notInstalledByDorkos: z.boolean().optional(),
    /** Pick up an open passive card after a restart and never raise a new one. */
    resumeOnly: z.boolean().optional(),
  }),
  z.strictObject({ kind: z.literal('folder_allows'), request: FolderAllowRequestSchema }),
  z.strictObject({ kind: z.literal('folder_config'), request: FolderConfigRequestSchema }),
  z.strictObject({ kind: z.literal('repo_config'), request: RepoConfigRequestSchema }),
]);

/** What the computer wants a person to decide, by kind. */
export type AskRequest = z.infer<typeof AskRequestSchema>;

/**
 * How an ask ended. Only `granted` allows anything.
 *
 * - The approval's own ends: `granted`, `denied`, `incomplete`, `expired`,
 *   `consumed`, `unknown`, `mismatched`.
 * - `timed_out`: the card's deadline passed on this clock before the store
 *   said so.
 * - `nothing_open`: a resume found no open card for exactly this request.
 * - `refused_on_record`: a yes on an old passive card, while a no for the same
 *   commands is on record; the no wins.
 * - `undone`, `changed`: what the card asked about went back, or changed again,
 *   while it was open; the card was taken down and nothing recorded.
 * - `unwired`: no space side was there to ask, so nobody was asked.
 */
export const AskOutcomeSchema = z.enum([
  'granted',
  'denied',
  'incomplete',
  'expired',
  'consumed',
  'unknown',
  'mismatched',
  'timed_out',
  'nothing_open',
  'refused_on_record',
  'undone',
  'changed',
  'unwired',
]);

/** How an ask ended. */
export type AskOutcome = z.infer<typeof AskOutcomeSchema>;

/** The answer to an ask: only the outcome. The space side already wrote what it means. */
export const AskAnswerSchema = z.strictObject({ outcome: AskOutcomeSchema });

/** The answer to an ask. */
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

/** A standing decision the computer may make with no card, for the space side to write. */
export const StandingDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    /** A folder allow list that only narrowed, or a person's Always allow at home. */
    kind: z.literal('folder_allows_approved'),
    agentId: z.string().min(1),
    home: z.string().min(1),
    rules: z.array(z.string()).readonly(),
    /** The config-write log line. */
    reason: z.string(),
  }),
  z.strictObject({
    /** An agent's folder settings pinned with no card: at the upgrade, on first use, or made by a person. */
    kind: z.literal('folder_config_approved'),
    agentId: z.string().min(1),
    home: z.string().min(1),
    digests: FolderConfigDigestsSchema,
    reason: z.string(),
  }),
  z.strictObject({
    /** A person changed one part through DorkOS: move the agent's yes for it from `before` to `after`. */
    kind: z.literal('folder_config_repinned'),
    agentId: z.string().min(1),
    home: z.string().min(1),
    part: FolderConfigPartSchema,
    before: z.string(),
    after: z.string(),
    reason: z.string(),
  }),
  /** The agents DorkOS already had were pinned at the upgrade (`harness.folderConfigPinned`). */
  z.strictObject({ kind: z.literal('folder_configs_pinned') }),
  z.strictObject({
    /** A worktree's local settings, as they read with a person's Always allow added. */
    kind: z.literal('repo_config_approved'),
    setting: RepoConfigKindSchema,
    digest: z.string().min(1),
  }),
  z.strictObject({
    /** The commit a repo was compared against: pinned at the upgrade, or moved forward with no hook change. */
    kind: z.literal('repo_baseline'),
    commonDir: z.string().min(1),
    baseline: RecordedBaselineSchema,
  }),
  /** The repos DorkOS already knew were pinned at the upgrade (`harness.repoBaselinesPinned`). */
  z.strictObject({ kind: z.literal('repo_baselines_pinned') }),
  z.strictObject({
    /** Pin today's files onto a package's yes recorded before files were pinned. */
    kind: z.literal('hook_files_pinned'),
    request: HookProjectionRequestSchema,
  }),
  z.strictObject({
    /** A person approved a worktree's `workspace.json` hooks with the review they were shown. */
    kind: z.literal('workspace_hooks_approved'),
    entry: z.string().min(1),
  }),
]);

/** A standing decision the computer may make with no card. */
export type StandingDecision = z.infer<typeof StandingDecisionSchema>;

// === The port ===

/** What a card's wait finds when it reads again what it asked about. */
export type AskWatchResult = 'unchanged' | 'undone' | 'changed';

/**
 * The computer's re-read of what an open card asks about, called between
 * presentations. The in-process handle this port allows (the spec's I7 table);
 * over a wire the computer withdraws the ask itself.
 */
export type AskWatch = () => AskWatchResult | Promise<AskWatchResult>;

/** The asks port, as computer-side code holds it. */
export interface ComputerAsks {
  /**
   * Put a card in front of a person and wait for the answer. The space side
   * records a yes or a no before it answers.
   *
   * @param request - What the computer wants decided.
   * @param watch - Reads what the card asks about again while it is open.
   */
  raise(request: AskRequest, watch?: AskWatch): Promise<AskAnswer>;
  /**
   * Have the space side write a standing decision that needs no card.
   *
   * @param decision - The decision and why.
   */
  record(decision: StandingDecision): void;
  /** The declined hook requests a person asked to review again, to pick up after a restart. */
  reaskedHooks(): HookProjectionRequest[];
  /**
   * Whether a person asked to review this declined hook request again.
   *
   * @param request - The package, project, hooks and files.
   */
  isReaskedHook(request: HookProjectionRequest): boolean;
}

/** The port before a space side wires it: nobody is asked and nothing is recorded. */
export const UNWIRED_COMPUTER_ASKS: ComputerAsks = Object.freeze({
  raise: () => Promise.resolve({ outcome: 'unwired' as const }),
  record: () => undefined,
  reaskedHooks: () => [],
  isReaskedHook: () => false,
});

/** A holder for the port, filled at startup; reads {@link UNWIRED_COMPUTER_ASKS} until then. */
export interface ComputerAsksSlot {
  /**
   * Hand over the port, or clear it.
   *
   * @param next - The port, or `undefined` to clear it.
   */
  set(next: ComputerAsks | undefined): void;
  /** The port, or {@link UNWIRED_COMPUTER_ASKS} when none is set. */
  get(): ComputerAsks;
  /** Whether a port is set. */
  wired(): boolean;
}

/** Make a holder for the port; each computer-side folder that asks keeps one. */
export function createComputerAsksSlot(): ComputerAsksSlot {
  let held: ComputerAsks | undefined;
  return {
    set: (next) => {
      held = next;
    },
    get: () => held ?? UNWIRED_COMPUTER_ASKS,
    wired: () => held !== undefined,
  };
}
