/**
 * What a warm process was launched with, and whether the next dispatch may ride
 * it (spec `persistent-session-runtime` §4.5, task 3.5).
 *
 * ## The problem
 *
 * On the resume-per-message path every launch parameter is resolved fresh
 * inside `executeSdkQuery`, so a change to any of them simply takes effect on
 * the next message. A pump resolves them ONCE, at launch, and then holds the
 * process for as long as the session stays warm — so a change to any of them
 * silently stops taking effect. The fingerprint is the record of what a live
 * process is actually running under, and {@link compareLaunchFingerprints} is
 * the question asked before every dispatch: may this message ride that process,
 * or must it be reaped and relaunched first?
 *
 * ## Why this lives on the launcher's side of the pump seam
 *
 * Everything pinned at launch is resolved by the {@link PumpLauncher}, not by
 * the pump: the pump is handed a live query and never sees an `Options` object.
 * So the fingerprint is captured from what the launcher passed to `query()`,
 * and compared by the launcher before it dispatches. The pump stays a state
 * machine that knows nothing about accounts.
 *
 * ## The account row is a security control
 *
 * A Claude account IS a config directory: it carries that account's transcripts
 * and its own sign-in, so the account a process launched under is the account
 * its work BILLS to (`claude-config-dir.ts`). A dispatch that rides a process
 * launched under a different account bills a paying client's conversation to
 * someone else, and no other row in the list has that consequence. The account
 * is therefore compared FIRST, UNCONDITIONALLY, and again through the ordinary
 * pin loop, and {@link applyLiveChanges} re-asks the same question before it
 * touches a live process. Do not add an equality shortcut in front of it: the
 * cost of the check is two string compares, and the cost of skipping it is
 * somebody else's invoice.
 *
 * ## Two rows are pinned by something other than their value, on purpose
 *
 * - **The agent identity token.** `agent-identity-service.mint()` returns fresh
 *   random bytes on every call, so the token VALUE differs between any two
 *   resolutions of the SAME identity. Pinning the value would force a relaunch
 *   on every dispatch and warmth would never exist. What actually changes the
 *   process's authority is the identity it was minted for, so that is the pin —
 *   and revocation needs no relaunch either way, because a revoked token stops
 *   resolving for the live process too.
 * - **In-process MCP servers.** The server factory builds new `McpServer`
 *   objects per launch on purpose (reusing one raises "Already connected to a
 *   transport"), so instance identity says nothing. The pin is the server SET —
 *   names and transports — because reconnecting every server on every dispatch
 *   would be a real cost paid for no change.
 *
 * ## Verdict on the SDK's native `WarmQuery` (asked by DOR-1170)
 *
 * **It changes nothing about this module, and that is the answer to the
 * question.** `startup({ options })` takes the SAME `Options` object a launch
 * would, `resume` included, and awaits the subprocess's initialize before
 * handing back a handle (read from the shipped `sdk.mjs`, 0.3.224, not only the
 * types). Every value in the pin list is therefore still resolved once, at
 * launch, under either boot path — there is no version of `WarmQuery` in which
 * the account stops being pinned, so the fingerprint, its comparison and the
 * account rule are identical either way.
 *
 * Where it IS interesting is the pump's `warm()` path, which today boots
 * through `createIdlePrompt()` — a held stream with no message in it — purely
 * to get a process up without opening a turn. `startup()` does exactly that
 * with no prompt at all, and its one-shot `query(prompt)` (a second call throws
 * `WarmQuery.query() can only be called once`) is not a constraint for us,
 * because a pump calls `query()` once per PROCESS anyway. Its default
 * `initializeTimeoutMs` of 60 s is also the pump's own `INIT_TIMEOUT_MS`.
 *
 * Not adopted here, for scope rather than merit: it would edit
 * `session-pump.ts`'s boot path, which this task does not own, and it buys task
 * 3.5 nothing. Worth raising against the pump itself.
 *
 * ## A fingerprint match is not a boundary check
 *
 * The `cwd` pin asks "is this the same directory the process was launched in",
 * never "is this directory one the person allowed". Two launches outside the
 * boundary have identical fingerprints. Boundary validation moves to dispatch
 * in task 3.9 and is a separate gate; do not let a `reuse` here stand in for it.
 *
 * @module services/runtimes/claude-code/sessions/launch-fingerprint
 */
import { createHash } from 'crypto';
import path from 'path';
import type {
  McpServerConfig,
  Options,
  PermissionMode,
  SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TOKEN_ENV_VAR } from '../../../core/agent-identity/index.js';

/**
 * Every launch parameter the pin list governs, and what a change to it costs.
 *
 * One entry per field of spec §4.5's table — the three rows that name several
 * fields (`model`/`effort`/`fastMode`, `settingSources`/`env`) are split, since
 * the spec asks for a verdict per field. `launch-fingerprint.test.ts` pins this
 * object against that table, so a launch option added without a decision fails
 * a test rather than silently defaulting to "rides the warm process".
 *
 * The `relaunch` verdicts on `effort` and `fastMode` are deliberate and are NOT
 * "the SDK cannot do it" — see `claude-code/NOTES.md` for what was verified per
 * field and why each landed where it did.
 */
export const PIN_DISPOSITIONS = {
  /** The effective working directory (`message-sender.ts` cwd chain). */
  cwd: 'relaunch',
  /** The Claude account root, and the `CLAUDE_CONFIG_DIR` that spells it. */
  accountRoot: 'relaunch',
  /** `resolveClaudeCredentialEnv()`'s answer (ADR-0315), hashed. */
  credentialEnv: 'relaunch',
  /** Who `resolveAgentTokenEnv()` minted for — the identity, not the token. */
  agentIdentity: 'relaunch',
  /** The system-prompt append built from tool groups plus the caller's. */
  systemPromptAppend: 'relaunch',
  /** Which settings layers the CLI reads. */
  settingSources: 'relaunch',
  /** Everything else in the process env, hashed. */
  env: 'relaunch',
  /** The resolved reasoning options: SDK `effort` and its `thinking` block. */
  effort: 'relaunch',
  /** `settings.fastMode`. */
  fastMode: 'relaunch',
  /** Swapped on the live query with `setMcpServers`. */
  mcpServers: 'live',
  /** Refreshed on the live query with `reloadPlugins`. */
  plugins: 'live',
  /** Set on the live query with `setPermissionMode`. */
  permissionMode: 'live',
  /** Set on the live query with `setModel`. */
  model: 'live',
} as const satisfies Record<string, 'relaunch' | 'live'>;

/** A launch parameter the pin list governs. */
export type PinName = keyof typeof PIN_DISPOSITIONS;

/** A pin whose change forces a reap and relaunch. */
export type RelaunchPin = {
  [K in PinName]: (typeof PIN_DISPOSITIONS)[K] extends 'relaunch' ? K : never;
}[PinName];

/** A pin that is set on the live process instead of replacing it. */
export type LivePin = Exclude<PinName, RelaunchPin>;

/** The relaunch pins, in the order a relaunch reason lists them. */
export const RELAUNCH_PINS = (Object.keys(PIN_DISPOSITIONS) as PinName[]).filter(
  (pin): pin is RelaunchPin => PIN_DISPOSITIONS[pin] === 'relaunch'
);

/** The settable-live pins, in the order {@link applyLiveChanges} applies them. */
export const LIVE_PINS = (Object.keys(PIN_DISPOSITIONS) as PinName[]).filter(
  (pin): pin is LivePin => PIN_DISPOSITIONS[pin] === 'live'
);

/** Which Claude account a process runs and bills on. */
export interface AccountPin {
  /** The Claude config root the launcher resolved for this session. */
  readonly root: string;
  /**
   * The `CLAUDE_CONFIG_DIR` actually spelled into the subprocess env, or
   * `undefined` when the launch pins the default root by ABSENCE. The two are
   * different accounts to Claude Code's Keychain even when `root` matches, so
   * both are compared (`claudeConfigDirEnv`).
   */
  readonly configDirEnv: string | undefined;
}

/** Who the process was launched to act as, if anyone. */
export interface AgentIdentityPin {
  /** The agent's project directory. */
  readonly agentPath: string;
  /** The agent's display name, as attribution labels show it. */
  readonly displayName: string | undefined;
  /**
   * Whether a token was actually minted. A launch that could not mint runs
   * unattributed; asking for attribution afterwards is a change of authority
   * and relaunches, which is how a failed mint self-heals on the next message.
   */
  readonly attributed: boolean;
}

/** The live-settable values, as the process currently holds them. */
export interface LiveSettings {
  readonly model: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>> | undefined;
  readonly plugins: readonly SdkPluginConfig[] | undefined;
}

/** What a launch was pinned to, captured at the moment it happened. */
export interface LaunchFingerprint {
  /** Compared first and unconditionally. Also present in {@link pins}. */
  readonly account: AccountPin;
  /** One comparable value per relaunch pin. Secret-bearing rows are hashed. */
  readonly pins: Readonly<Record<RelaunchPin, string>>;
  /** The values a live process can still be moved to. */
  readonly live: LiveSettings;
}

/** Everything a launcher resolved for one launch, as it resolved it. */
export interface LaunchParams {
  /**
   * The Claude config root this launch resolved
   * (`session.accountRoot ?? resolveActiveClaudeRoot()`).
   */
  readonly accountRoot: string;
  /** Exactly the options handed to `query()`. */
  readonly options: Options;
  /** `resolveClaudeCredentialEnv()`'s answer for this launch. */
  readonly credentialEnv: Readonly<Record<string, string>>;
  /** Who `resolveAgentTokenEnv()` was asked to mint for, or nobody. */
  readonly agentIdentity: AgentIdentityPin | undefined;
}

/** One live-settable value that moved, and what to set it to. */
export type LiveChange =
  | { readonly pin: 'model'; readonly model: string | undefined }
  | { readonly pin: 'permissionMode'; readonly mode: PermissionMode }
  | { readonly pin: 'mcpServers'; readonly servers: Record<string, McpServerConfig> }
  | { readonly pin: 'plugins' };

/** Ride the warm process, once {@link liveChanges} have been applied to it. */
export interface ReuseDecision {
  readonly action: 'reuse';
  readonly from: LaunchFingerprint;
  readonly to: LaunchFingerprint;
  readonly liveChanges: readonly LiveChange[];
}

/** Reap the process and launch a new one before the turn opens. */
export interface RelaunchDecision {
  readonly action: 'relaunch';
  readonly from: LaunchFingerprint;
  readonly to: LaunchFingerprint;
  /** Every pin that moved, in {@link PIN_DISPOSITIONS} order. Never empty. */
  readonly changed: readonly RelaunchPin[];
  /** A log-safe sentence naming the pins. Carries no secret. */
  readonly reason: string;
}

/** What the launcher learned by comparing a live process to a wanted launch. */
export type DispatchDecision = ReuseDecision | RelaunchDecision;

/**
 * A cross-account reuse was attempted. Named, and its own class, because it is
 * the one failure in this module that is a security event rather than a bug.
 */
export class AccountPinViolationError extends Error {
  /**
   * Report the two accounts that were about to be conflated.
   *
   * @param live - The account the live process runs and bills on
   * @param wanted - The account the dispatch belongs to
   */
  constructor(
    readonly live: AccountPin,
    readonly wanted: AccountPin
  ) {
    super(
      `refusing to run a dispatch for Claude account ${describeAccount(wanted)} on a process launched under ${describeAccount(live)}`
    );
    this.name = 'AccountPinViolationError';
  }
}

/** An account in one legible phrase, for errors and logs. Paths, never secrets. */
function describeAccount(account: AccountPin): string {
  const spelled = account.configDirEnv ?? '<CLAUDE_CONFIG_DIR unset>';
  return `${account.root} (${spelled})`;
}

/** A stable digest of a secret-bearing value: comparable, never readable. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The separator every serialized pin uses. NUL rather than a space or a colon
 * because it cannot occur in a path, an env value or an agent name, so two
 * different pins can never serialize to the same string by splicing.
 */
const FIELD_SEP = '\u0000';

/** Env entries as one deterministic string, `skip` omitted. */
function serializeEnv(
  env: Readonly<Record<string, string | undefined>>,
  skip: ReadonlySet<string>
) {
  return Object.keys(env)
    .filter((key) => !skip.has(key))
    .sort()
    .map((key) => `${key}=${env[key] ?? ''}`)
    .join(FIELD_SEP);
}

/**
 * The MCP server set as a comparable descriptor: what each server IS, never the
 * live object it is served by. See the module doc for why instances are ignored.
 */
function describeMcpServers(
  servers: Readonly<Record<string, McpServerConfig>> | undefined
): string {
  if (!servers) return '';
  return Object.keys(servers)
    .sort()
    .map((name) => {
      const config = servers[name]!;
      const type = config.type ?? 'stdio';
      if (type === 'sdk') return `${name}:sdk`;
      if ('url' in config) return `${name}:${type}:${config.url}`;
      if ('command' in config)
        return `${name}:${type}:${config.command} ${(config.args ?? []).join(' ')}`;
      return `${name}:${type}`;
    })
    .join(FIELD_SEP);
}

/** The activated plugin list as a comparable descriptor. */
function describePlugins(plugins: readonly SdkPluginConfig[] | undefined): string {
  if (!plugins) return '';
  return [...plugins]
    .map((plugin) => `${plugin.type}:${plugin.path}`)
    .sort()
    .join(FIELD_SEP);
}

/** The identity pin as a comparable descriptor. */
function describeAgentIdentity(identity: AgentIdentityPin | undefined): string {
  if (!identity) return '<unattributed>';
  const state = identity.attributed ? 'token' : 'mint-failed';
  return [state, identity.agentPath, identity.displayName ?? ''].join(FIELD_SEP);
}

/** The system-prompt append, whichever shape the preset config took. */
function readSystemPromptAppend(prompt: Options['systemPrompt']): string {
  if (typeof prompt === 'string') return prompt;
  if (prompt && typeof prompt === 'object' && 'append' in prompt) return prompt.append ?? '';
  return '';
}

/**
 * Record what a launch is pinned to, at the moment the launcher hands its
 * options to `query()`.
 *
 * @param launch - Everything the launcher resolved, as it resolved it
 * @returns The fingerprint to store on the pump and compare on every dispatch
 * @throws AccountPinViolationError When `options.env.CLAUDE_CONFIG_DIR` names a
 *   different account than `accountRoot`. That disagreement means the launch
 *   will bill somewhere other than the launcher believes, and it is caught here
 *   rather than surviving as a fingerprint that certifies the wrong account.
 */
export function captureLaunchFingerprint(launch: LaunchParams): LaunchFingerprint {
  const { accountRoot, options, credentialEnv, agentIdentity } = launch;
  const env = (options.env ?? {}) as Readonly<Record<string, string | undefined>>;
  const configDirEnv = env.CLAUDE_CONFIG_DIR;
  const account: AccountPin = { root: accountRoot, configDirEnv };
  // A spelled-out directory that is not the resolved root is a launch already
  // pointed at the wrong account. An ABSENT one is the faithful spelling of the
  // SDK's default root and cannot be checked here without resolving `~/.claude`,
  // which only `claude-config-dir.ts` may do; the launcher owns that pairing.
  if (configDirEnv !== undefined && !samePath(configDirEnv, accountRoot)) {
    throw new AccountPinViolationError({ root: configDirEnv, configDirEnv }, account);
  }
  // The env pin covers everything the three env-borne pins above do NOT, so the
  // partition is complete and each row is independently comparable.
  const owned = new Set(['CLAUDE_CONFIG_DIR', AGENT_TOKEN_ENV_VAR, ...Object.keys(credentialEnv)]);
  return {
    account,
    pins: {
      cwd: options.cwd ?? '',
      accountRoot: [path.normalize(accountRoot), configDirEnv ?? '<unset>'].join(FIELD_SEP),
      credentialEnv: digest(serializeEnv(credentialEnv, new Set())),
      agentIdentity: describeAgentIdentity(agentIdentity),
      systemPromptAppend: digest(readSystemPromptAppend(options.systemPrompt)),
      settingSources: (options.settingSources ?? []).join(','),
      env: digest(serializeEnv(env, owned)),
      // `effort` and `thinking` are one decision resolved together against the
      // model's capability (`thinking-config.ts`), so they are one pin. This is
      // also what makes a live `setModel` safe: a model change that would have
      // resolved DIFFERENT reasoning options moves this pin and relaunches.
      effort: JSON.stringify({ effort: options.effort, thinking: options.thinking }),
      fastMode: String(
        typeof options.settings === 'object' && options.settings !== null
          ? ((options.settings as { fastMode?: boolean }).fastMode ?? false)
          : false
      ),
    },
    live: {
      model: options.model,
      permissionMode: options.permissionMode,
      mcpServers: options.mcpServers,
      plugins: options.plugins,
    },
  };
}

/** Do two paths name the same directory? */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Are these the same Claude account? Both the resolved root and the spelling
 * that reaches the subprocess must agree — see {@link AccountPin.configDirEnv}.
 *
 * @param live - The account the live process runs on
 * @param wanted - The account the dispatch belongs to
 */
export function accountsMatch(live: AccountPin, wanted: AccountPin): boolean {
  return samePath(live.root, wanted.root) && live.configDirEnv === wanted.configDirEnv;
}

/** The live-settable values that moved, in {@link LIVE_PINS} order. */
function diffLiveSettings(live: LiveSettings, wanted: LiveSettings): LiveChange[] {
  const changes: LiveChange[] = [];
  for (const pin of LIVE_PINS) {
    switch (pin) {
      case 'model':
        // `setModel(undefined)` is the SDK's own "back to the default", so an
        // unset model is a real value here rather than a missing one.
        if (live.model !== wanted.model) changes.push({ pin, model: wanted.model });
        break;
      case 'permissionMode':
        // An unset wanted mode means "whatever the CLI defaults to", which
        // `setPermissionMode` has no way to say. The launcher always sets one
        // (`message-sender.ts` assigns it unconditionally), so this is left as
        // a no-op rather than guessed at.
        if (wanted.permissionMode !== undefined && live.permissionMode !== wanted.permissionMode) {
          changes.push({ pin, mode: wanted.permissionMode });
        }
        break;
      case 'mcpServers':
        if (describeMcpServers(live.mcpServers) !== describeMcpServers(wanted.mcpServers)) {
          changes.push({ pin, servers: { ...(wanted.mcpServers ?? {}) } });
        }
        break;
      case 'plugins':
        if (describePlugins(live.plugins) !== describePlugins(wanted.plugins))
          changes.push({ pin });
        break;
    }
  }
  return changes;
}

/**
 * May a dispatch pinned to `wanted` ride a process launched under `live`?
 *
 * The account is answered first and on its own, before any other pin is looked
 * at and with no equality shortcut in front of it, because "these two
 * fingerprints are otherwise identical" must never be able to carry a dispatch
 * onto another client's account. It is then compared AGAIN by the ordinary pin
 * loop; the redundancy is deliberate.
 *
 * @param live - What the running process was launched with
 * @param wanted - What this dispatch would launch with today
 * @returns A relaunch decision naming every pin that moved, or a reuse decision
 *   carrying the live changes to apply before the turn opens
 */
export function compareLaunchFingerprints(
  live: LaunchFingerprint,
  wanted: LaunchFingerprint
): DispatchDecision {
  const changed = new Set<RelaunchPin>();
  if (!accountsMatch(live.account, wanted.account)) changed.add('accountRoot');
  for (const pin of RELAUNCH_PINS) {
    if (live.pins[pin] !== wanted.pins[pin]) changed.add(pin);
  }
  if (changed.size > 0) {
    const moved = RELAUNCH_PINS.filter((pin) => changed.has(pin));
    return {
      action: 'relaunch',
      from: live,
      to: wanted,
      changed: moved,
      reason: `relaunching: ${moved.join(', ')} changed since this process was launched`,
    };
  }
  return {
    action: 'reuse',
    from: live,
    to: wanted,
    liveChanges: diffLiveSettings(live.live, wanted.live),
  };
}
