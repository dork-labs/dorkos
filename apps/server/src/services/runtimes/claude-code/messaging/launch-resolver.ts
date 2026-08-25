/**
 * Everything a claude-code launch is resolved from, in one place, so the two
 * dispatch paths cannot drift (spec `persistent-session-runtime` §P3, task
 * 3.10).
 *
 * ## Why this was extracted
 *
 * `executeSdkQuery` used to resolve the working directory, the agent manifest,
 * the tool groups, the system-prompt append, the account, the credentials, the
 * identity token and the whole `Options` object inline, and then call `query()`
 * on the next line. That was fine while a turn WAS a launch. The persistent
 * pump launches once and serves many turns, so it needs the same resolution
 * without the `query()` — and it needs the result twice over: once to boot the
 * process, and once per dispatch to ask whether the process it already has was
 * launched with these same values ({@link LaunchParams} feeds
 * `captureLaunchFingerprint`).
 *
 * Two copies of this resolution would be the worst possible outcome: the pin
 * list compares a fingerprint taken from ONE of them, so a value the other copy
 * resolved differently would read as "no change" and a stale process would keep
 * serving turns. One function, both callers.
 *
 * ## What it deliberately does not do
 *
 * - **It does not check the directory boundary.** The caller resolves the cwd
 *   ({@link resolveEffectiveCwd}) and gates it, because the two paths surface a
 *   refusal differently — the turn path yields `boundaryViolationEvent`, the
 *   pump path throws out of `SessionTurnWindows.dispatch`. Keeping the gate in
 *   the callers also preserves the turn path's ordering exactly: it refuses
 *   before reading a manifest, exactly as it always has.
 * - **It does not call `query()`.** The turn path holds a per-turn prompt; the
 *   pump holds one for the process's whole life.
 * - **It yields nothing.** The one event this resolution can produce — the
 *   auto-permission-mode downgrade notice — comes back as data in
 *   {@link ResolvedLaunch.statusEvents} for the caller to yield first, which is
 *   where the turn path has always emitted it.
 *
 * @module services/runtimes/claude-code/messaging/launch-resolver
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { readManifest } from '@dorkos/shared/manifest';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import { configManager } from '../../../core/config-manager.js';
import { resolveClaudeCredentialEnv } from '../../../core/credential-env.js';
import { resolveAgentTokenEnv } from '../../../core/agent-identity/index.js';
import { isRelayEnabled } from '../../../relay/relay-state.js';
import { isTasksEnabled } from '../../../tasks/task-state.js';
import type { AgentSession } from '../agent-types.js';
import { claudeConfigDirEnv, resolveLaunchAccountRoot } from '../claude-config-dir.js';
import type { AgentIdentityPin, LaunchParams } from '../sessions/launch-fingerprint.js';
import { resolveToolConfig } from '../tooling/tool-filter.js';
import { loadsAgentToAgentTools } from '../mcp-tools/tool-exposure.js';
import { buildSystemPromptAppend, renderContextEntry } from './context-builder.js';
import { createCanUseTool, handleElicitation } from './interactive-handlers.js';
import { mcpToolTimeoutFloorEnv } from './mcp-tool-timeout-env.js';
import { AUTO_DOWNGRADE_STATUS, resolveEffectivePermissionMode } from './permission-mode-guard.js';
import { resolveThinkingOptions } from './thinking-config.js';
import { createEditBaselineCapture, detectSlashCommandName } from './message-sender-shared.js';
import type { MessageSenderOpts } from './message-sender-shared.js';

/** What one launch resolution produced, for the caller to boot or compare with. */
export interface ResolvedLaunch {
  /** Exactly the options to hand `query({ options })`. */
  sdkOptions: Options;
  /**
   * The user message with the additional-context bag prepended, or the bare
   * trimmed command on a slash-command turn. Never the raw `content` field —
   * ADR-0273 keeps the person's own words unmutated.
   */
  enrichedContent: string;
  /** The mesh agent this working directory hosts, for `last_seen` stamping. */
  meshAgentId: string | undefined;
  /**
   * Events the caller must yield BEFORE the turn's own, in this order. Only the
   * auto-permission-mode downgrade notice lands here today.
   */
  statusEvents: StreamEvent[];
  /**
   * What this launch is pinned to, in the shape `captureLaunchFingerprint`
   * takes. Resolved even on the turn path, where nothing reads it: computing it
   * conditionally would mean the pump's fingerprint came from a code path the
   * turn path never exercises.
   */
  launch: LaunchParams;
}

/**
 * The working directory this turn runs in.
 *
 * The one resolution, for both the boundary gate and the launcher — hand the
 * SAME value to each. Resolved twice by two routes, the gate answers about one
 * directory while the process runs in another, which is a check that only looks
 * like one (`dispatch-boundary.ts`).
 *
 * Empty strings fall through rather than winning, because a stale relay binding
 * supplies one and it names no directory at all.
 *
 * @param opts - The runtime's own defaults (`sessionCwd` then `cwd`)
 * @param messageOpts - The caller's per-message override, if any
 */
export function resolveEffectiveCwd(opts: MessageSenderOpts, messageOpts?: MessageOpts): string {
  return messageOpts?.cwd || opts.sessionCwd || opts.cwd;
}

/**
 * Resolve everything a launch in `effectiveCwd` is pinned to, and the SDK
 * options that spell it.
 *
 * @param args - The session, its message, the runtime's ports, and the cwd the
 *   caller has already resolved and gated
 * @returns The options to launch with, the enriched message, and the pins
 */
export async function resolveLaunch(args: {
  sessionId: string;
  content: string;
  session: AgentSession;
  opts: MessageSenderOpts;
  messageOpts?: MessageOpts;
  effectiveCwd: string;
}): Promise<ResolvedLaunch> {
  const { sessionId, content, session, opts, messageOpts, effectiveCwd } = args;
  const statusEvents: StreamEvent[] = [];

  // Stamp agent last_seen_at when a message is dispatched
  const meshAgent = opts.meshCore?.getByPath(effectiveCwd);
  const meshAgentId = meshAgent?.id;
  if (opts.meshCore && meshAgentId) {
    opts.meshCore.updateLastSeen(meshAgentId, 'message_sent');
  }

  // Load agent manifest for the agent's per-agent tool-group settings. These decide
  // which tool docs reach the system prompt; they never restrict what is callable.
  let manifest: Awaited<ReturnType<typeof readManifest>> | null = null;
  try {
    manifest = await readManifest(effectiveCwd);
  } catch {
    // No manifest found -- all tools inherit global defaults
  }

  const globalConfig = configManager.get('agentContext') ?? {
    tasksTools: true,
    relayTools: true,
    meshTools: true,
    adapterTools: true,
  };

  const toolConfig = resolveToolConfig(manifest?.enabledToolGroups, {
    relayEnabled: isRelayEnabled(),
    tasksEnabled: isTasksEnabled(),
    globalConfig,
  });

  // Slash commands must reach the CLI as the bare prompt — it only parses a
  // command when `/` starts the message (DOR-107). Verify the name against the
  // known command list; a cold SDK cache (null) can't rule out built-ins, so
  // command-shaped content passes through and the CLI rejects unknown names.
  const commandName = detectSlashCommandName(content);
  let isCommandDispatch = false;
  if (commandName && opts.getKnownCommands) {
    const knownCommands = await opts.getKnownCommands();
    isCommandDispatch = knownCommands === null || knownCommands.includes(`/${commandName}`);
  }

  // Whether this turn's prompt already carries the six agent-to-agent tools
  // (DOR-1337 / F8). Decided by the SAME rule the tool server applies —
  // `loadsAgentToAgentTools` — over the SAME input: `session.cwd`, which is the
  // cwd `mcpServerFactory` hands `createDorkOsToolServer` a few lines below,
  // and which `resolveSenderIdentity` resolves this session's relay identity
  // from. Deliberately NOT `effectiveCwd`: a per-message `cwd` override moves
  // the turn's directory but not the session's identity, so keying the prose
  // there would claim the tools are loaded for a session whose tool server had
  // already decided otherwise — the failure inverted, and worse than the
  // original, because a wrong "no lookup needed" costs the whole turn.
  const baseAppend = await buildSystemPromptAppend(effectiveCwd, toolConfig, {
    agentSession: loadsAgentToAgentTools(
      !!(session.cwd && opts.meshCore?.getByPath(session.cwd)),
      isRelayEnabled()
    ),
  });
  // Concatenate caller-supplied append (e.g. Tasks scheduler context) after the
  // base — onto BOTH halves, so the caller's own per-run instructions are
  // digested by the relaunch pin exactly as they were before agent memory
  // existed. Only the `<agent_memory>` block is out of the digest; nothing else
  // moved, and a caller append that changed used to relaunch and still does.
  const callerAppend = messageOpts?.systemPromptAppend;
  const systemPromptAppend = callerAppend
    ? `${baseAppend.text}\n\n${callerAppend}`
    : baseAppend.text;
  const systemPromptAppendStable = callerAppend
    ? `${baseAppend.stable}\n\n${callerAppend}`
    : baseAppend.stable;

  // Prepend the server-assembled additional-context bag (git status, UI state,
  // queue note, …) to the user message — keeps it out of the system prompt to
  // preserve prompt cache hits on the static prefix. The user's `content` is
  // NEVER mutated: the prepend produces a separate `enrichedContent` and the
  // tags are stripped on render (ADR-0273).
  let enrichedContent = content;
  if (isCommandDispatch) {
    // DOR-107: a `/`-prefixed prompt must reach the CLI bare (leading whitespace
    // also breaks command parsing). NO context prepend on command turns. Retained.
    enrichedContent = content.trim();
  } else {
    const contextBlocks = (messageOpts?.additionalContext ?? [])
      .map(renderContextEntry)
      .filter(Boolean);
    if (contextBlocks.length > 0) {
      enrichedContent = `${contextBlocks.join('\n\n')}\n\n${content}`;
    }
  }

  // Resolve a stored Claude credential REFERENCE into ANTHROPIC_API_KEY at the
  // env seam (ADR-0315). Injected below ONLY when configured; a missing or
  // dangling reference yields `{}`, leaving host/delegated-login auth untouched.
  const claudeCredentialEnv = await resolveClaudeCredentialEnv();

  // Mint this session's agent identity token (spec `agent-trust` §3.1). It
  // rides the process env — NOT the context-builder's prompt block — so it
  // stays a credential for the tools the agent runs (`dorkos call ...`) rather
  // than text in the model's context and the transcript. Yields `{}` when the
  // working directory hosts no registered agent, leaving the session
  // unattributed exactly as before.
  //
  // The name it is minted under is the one a PERSON reads, never the slug.
  // `agents.name` is the address an `@` reaches; `display_name` is the label,
  // and the token's label is replayed onto the agent's author row every time it
  // uses a room tool (`room-capabilities.ts` → `AuthorRegistry.resolveAgent`).
  // Minting under the slug therefore renamed a live agent to `docs-writer`
  // mid-conversation, in every message and in the member list (DOR-1264).
  const agentDisplayName = meshAgent?.displayName ?? meshAgent?.name;
  const agentTokenEnv = await resolveAgentTokenEnv(
    meshAgent ? effectiveCwd : undefined,
    agentDisplayName
  );

  // Which Claude Code account this turn runs and BILLS on (spec
  // `claude-code-accounts` D3): the session's own account when disk has already
  // told us one — a resumed conversation must stay on the client whose
  // subscription paid for it, whichever account happens to be the default — else
  // the launch ladder, which is what a brand-new session runs on.
  //
  // **The `??` is the ladder's only gate** (spec `billing-account-ladder`
  // invariant 5). `session.accountRoot` is derived from the transcript on disk,
  // so its presence means this session has already launched and its account is
  // settled; running the ladder anyway would let a stale hint or a since-changed
  // agent setting move a live conversation's billing mid-stream. `undefined` is
  // "unknown", never an error: a session with no transcript yet legitimately has
  // no account of its own, and that is exactly the case the ladder answers.
  const accountRoot =
    session.accountRoot ??
    resolveLaunchAccountRoot({
      hintId: messageOpts?.accountHint,
      // The account this agent is pinned to, off the manifest already read
      // above. It reaches the spawn env and stops there — nothing writes it to
      // `session_metadata`, because disk stays the per-session truth.
      agentAccountId: manifest?.account,
    });
  const accountEnv = claudeConfigDirEnv(accountRoot);

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    includePartialMessages: true,
    promptSuggestions: true,
    agentProgressSummaries: true,
    // Stream subagent text deltas (tagged with parent_tool_use_id) so the operator
    // can watch what a subagent is doing, not just a progress spinner. Mapped to
    // `subagent_text_delta` events in sdk-event-mapper.ts (SDK 0.2.119+).
    forwardSubagentText: true,
    settingSources: ['local', 'project', 'user'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: systemPromptAppend,
      // Suppress the preset's native working-directory/auto-memory/git sections so
      // DorkOS's own server-derived <git_status> block is the single source of truth.
      // Ends the per-turn double-injection of git status (ADR-0273 decision A2).
      excludeDynamicSections: true,
    },
    toolConfig: {
      askUserQuestion: { previewFormat: 'html' },
    },
    env: {
      // eslint-disable-next-line no-restricted-syntax -- full env needed for SDK subprocess inheritance
      ...process.env,
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
      // An inherited MCP_TOOL_TIMEOUT shorter than the in-session approval hold
      // would kill every held destructive call mid-wait, with an ERROR where the
      // poll payload used to be. Floored, never erased — see the module TSDoc for
      // the tradeoff (DOR-987).
      ...mcpToolTimeoutFloorEnv(),
      // The account, ALWAYS spelled out (see `claudeConfigDirEnv`) so it is never
      // inherited from `process.env`. That is load-bearing for D8: rename and
      // fork point the in-process SDK at an account by mutating
      // `process.env.CLAUDE_CONFIG_DIR` process-globally for the duration of the
      // call (`claude-config-env-lock.ts`), and a query spawning inside that
      // window must not pick the transient value up. The two changes are safe
      // only together — do not separate them.
      ...accountEnv,
      // Resolved credential (if any) wins over an inherited ANTHROPIC_API_KEY.
      ...claudeCredentialEnv,
      // This session's freshly minted agent identity token (or nothing).
      ...agentTokenEnv,
    },
    ...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
  };

  // Set the session title on the first turn when the caller supplies one
  // (SDK 0.2.113 `title` option — skips auto-generation). Ignored on resume.
  if (!session.hasStarted && messageOpts?.title) {
    sdkOptions.title = messageOpts.title;
  }

  if (session.hasStarted) {
    sdkOptions.resume = session.sdkSessionId;
    // Anchor the resume at the last main-thread assistant message this session
    // produced. Without this, the claude CLI's resume classifier treats a
    // trailing bookkeeping attachment — a Stop-hook `hook_success` entry, a
    // skill/agent listing — as an `interrupted_turn` and injects a synthetic
    // "Continue from where you left off." prompt (`getResumePrompt()`), which the
    // model answers "No response requested." BEFORE our real message runs, so the
    // operator sees a junk turn between every interaction (DOR phantom-continue).
    // Truncating the resume to the last assistant excludes those trailing
    // attachments, so the classifier settles the turn cleanly and our message is
    // the next turn's sole prompt. The anchor is undefined on a cold resume or a
    // no-assistant turn — a plain resume, unchanged behavior. `resumeSessionAt`
    // never rewrites the transcript file, so nothing is lost: only what THIS
    // resume loads is truncated (the excluded attachments stay on disk).
    if (session.lastAssistantUuid) {
      sdkOptions.resumeSessionAt = session.lastAssistantUuid;
    }
    if (session.sdkSessionId === sessionId) {
      logger.debug(
        '[sendMessage] resuming with sdkSessionId === sessionId (expected after server restart)',
        {
          session: sessionId,
        }
      );
    }
  }

  // CWD resolution chain: opts.cwd (from caller) -> session.cwd (from creation) -> this.cwd (default)
  const cwdSource = messageOpts?.cwd ? 'opts.cwd' : opts.sessionCwd ? 'session.cwd' : 'default';
  logger.debug('[sendMessage]', {
    session: sessionId,
    permissionMode: session.permissionMode,
    hasStarted: session.hasStarted,
    resume: session.hasStarted ? session.sdkSessionId : 'N/A',
    effectiveCwd,
    cwdSource,
    'opts.cwd': messageOpts?.cwd || '(empty)',
    'session.cwd': opts.sessionCwd || '(empty)',
  });

  // Reconcile the permission mode against the active model: `'auto'` only works on
  // models KNOWN to support it, so coerce it to `'default'` here (the runtime is the
  // authoritative chokepoint) rather than letting the SDK 400. This is a per-query
  // coercion only — we deliberately do NOT mutate `session.permissionMode`, so the
  // operator's Auto choice isn't silently destroyed: the displayed mode stays honest,
  // the status note fires each send the model can't be trusted with Auto, and Auto
  // resumes automatically once it can be. The note's wording follows the REASON —
  // an unconfirmed model must not be described as one that lacks Auto.
  const { permissionMode: effectivePermissionMode, autoDowngrade } = resolveEffectivePermissionMode(
    {
      permissionMode: session.permissionMode,
      modelSupportsAutoMode: opts.modelSupportsAutoMode,
    }
  );
  if (autoDowngrade) {
    statusEvents.push({
      type: 'system_status',
      data: { message: AUTO_DOWNGRADE_STATUS[autoDowngrade] },
    });
  }
  // The schema validates valid values upstream; no allowlist needed here.
  sdkOptions.permissionMode = effectivePermissionMode;
  // Always launch with the bypass capability (ADR-0261). The flag is a pure
  // capability gate the SDK consults ONLY when permissionMode is
  // 'bypassPermissions' — verified inert in default/acceptEdits/plan, which
  // still route to canUseTool. Granting it unconditionally lets the operator
  // switch a live session to bypass instantly (query.setPermissionMode),
  // instead of the SDK rejecting the escalation because the session wasn't
  // launched with it.
  sdkOptions.allowDangerouslySkipPermissions = true;

  if (session.model) {
    sdkOptions.model = session.model;
  }
  // Resolve thinking + effort together: adaptive-capable models (Opus 4.8/4.7 default
  // their thinking to omitted) get `display: 'summarized'` so thinking text streams;
  // non-adaptive models are left untouched. Also normalizes DorkOS-only effort values
  // (`none`/`minimal`) that the SDK does not accept.
  const { thinking, effort } = resolveThinkingOptions({
    effort: session.effort,
    capability: opts.modelThinkingCapability,
  });
  if (thinking) {
    sdkOptions.thinking = thinking;
  }
  if (effort) {
    sdkOptions.effort = effort;
  }
  // Pass fastMode via SDK settings (not top-level options).
  // The SDK uses Settings.fastMode.
  if (session.fastMode) {
    const base = typeof sdkOptions.settings === 'object' ? sdkOptions.settings : {};
    sdkOptions.settings = {
      ...base,
      fastMode: true,
    };
  }

  // Inject MCP tool servers -- create fresh instances per query to avoid
  // "Already connected to a transport" errors from reused Protocol objects.
  if (opts.mcpServerFactory) {
    sdkOptions.mcpServers = opts.mcpServerFactory(session, sessionId);
  }

  // Nothing here sets `allowedTools`, on purpose (DOR-519). The tool-group toggles
  // used to feed it a list, on the premise that the SDK option restricts which tools
  // a session may call. It does not: it auto-approves the names in it. Because the
  // list was only non-empty once a group was turned OFF, turning a group off widened
  // this agent's auto-approval instead of narrowing its access. Every DorkOS tool now
  // goes through `canUseTool` below, which auto-approves only `DORKOS_AGENT_TOOLS`.
  // The toggles still take effect through `buildSystemPromptAppend` above, which
  // leaves a disabled group's tool block out of the agent's context.
  const editBaselineCapture = createEditBaselineCapture(sessionId, effectiveCwd);
  sdkOptions.canUseTool = createCanUseTool(session, logger, editBaselineCapture);
  // Pre-edit baseline capture must ALSO ride the SDK PreToolUse hook (DOR-212):
  // `canUseTool` is skipped entirely under `bypassPermissions`, but PreToolUse
  // hooks fire in every mode, before the tool runs. The matcher confines the
  // callback to the edit-family tools; the callback itself never blocks or
  // modifies the tool (`continue: true`). First-touch-wins in the store makes
  // the canUseTool+hook double-fire a no-op.
  //
  // Whether BACKGROUNDED (async) subagents also arrive at `canUseTool` is
  // UNRESOLVED and is not asserted either way (DOR-795, DOR-782); the full
  // reasoning is preserved in `message-sender.ts`'s history. Either way the
  // backstop holds: `interactive-handlers.ts` auto-denies on abort and on
  // timeout, so a prompt that arrives outside a foreground turn degrades
  // gracefully rather than hanging one.
  sdkOptions.hooks = {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          async (hookInput) => {
            if (hookInput.hook_event_name === 'PreToolUse') {
              await editBaselineCapture(
                hookInput.tool_name,
                (hookInput.tool_input ?? {}) as Record<string, unknown>
              );
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
  sdkOptions.onElicitation = (request, { signal }) => {
    logger.debug('[sendMessage] elicitation request', {
      session: sessionId,
      serverName: request.serverName,
      mode: request.mode,
    });
    return handleElicitation(session, request, signal);
  };

  // Activate installed marketplace plugins (marketplace-05, ADR-0239).
  // The runtime pre-resolves the plugin list via `opts.plugins`; this module
  // does not touch the filesystem itself so fake-timer tests stay simple.
  if (opts.plugins && opts.plugins.length > 0) {
    (sdkOptions as Options & { plugins?: unknown }).plugins = opts.plugins;
    logger.debug('[sendMessage] activated marketplace plugins', {
      session: sessionId,
      count: opts.plugins.length,
    });
  }

  // Who the process is launched to ACT as, pinned by identity rather than by
  // token value — `mint()` returns fresh bytes every call, so pinning the value
  // would relaunch on every dispatch and warmth would never exist
  // (`launch-fingerprint.ts`).
  const agentIdentity: AgentIdentityPin | undefined = meshAgent
    ? {
        agentPath: effectiveCwd,
        // The same string the mint above was given: the pin describes who this
        // launch was minted FOR, so a second name here would be a fingerprint
        // of something that never happened.
        //
        // It is also the ONLY thing that keeps a token's label fresh, which
        // makes it load-bearing rather than bookkeeping. `describeAgentIdentity`
        // (`launch-fingerprint.ts`) folds this name into a `relaunch` pin, so
        // renaming an agent ends the warm process and the next turn mints a new
        // token under the new name. Drop it from the descriptor and a long-lived
        // warm session would keep attributing every room message that agent
        // writes to the name it had when the process started.
        displayName: agentDisplayName,
        attributed: Object.keys(agentTokenEnv).length > 0,
      }
    : undefined;

  return {
    sdkOptions,
    enrichedContent,
    meshAgentId,
    statusEvents,
    launch: {
      accountRoot,
      options: sdkOptions,
      // The append MINUS the agent's own memory block — see
      // `LaunchParams.systemPromptAppendStable`. Handed over explicitly rather
      // than read back off `sdkOptions.systemPrompt`, because what is on the
      // prompt includes the memory and what the digest may see must not.
      systemPromptAppendStable,
      credentialEnv: claudeCredentialEnv,
      ...(agentIdentity !== undefined ? { agentIdentity } : { agentIdentity: undefined }),
      // The raw setting, plus whether it was resolved against a known model
      // capability — together they let `compareLaunchFingerprints` tell a
      // real effort change from the capability cache warming up mid-session
      // (DOR-1308).
      effortInput: session.effort,
      capabilityResolved: opts.modelThinkingCapability !== undefined,
    },
  };
}
