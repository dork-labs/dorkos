/**
 * interactive-handlers: approval gate. Shared setup lives in `./interactive-handlers.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCanUseTool, type ToolApprovalContext } from '../../interactive-handlers.js';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { makeSession, makeContext, noopLog } from './interactive-handlers.fixtures.js';

describe('createCanUseTool — approval gate', () => {
  const NON_SAFE_TOOL = 'Bash';

  it('routes a non-safe tool to approval (not auto-allow) in default mode', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);

    // handleToolApproval never resolves until the user responds, so we race the
    // pending promise against a microtask and assert it stayed pending while
    // pushing an approval_required event to the queue.
    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-1'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-1')).toBe(true);
  });

  it('routes a non-safe tool to approval (not auto-allow) in auto mode', async () => {
    const session = makeSession('auto');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-2'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-2')).toBe(true);
  });

  // DOR-604. This is the security regression test: a Slack/Telegram message
  // routed through a binding lands on `acceptEdits`, and `Bash` used to be
  // auto-allowed from there — an off-machine message ran a local shell command
  // with nobody asked. `acceptEdits` ships the description "Auto-accept file
  // edits; still prompt for other tools"; `Bash` is an other tool.
  it('raises an approval card for Bash in acceptEdits mode instead of running it', async () => {
    const session = makeSession('acceptEdits');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool('Bash', { command: 'rm -rf ~/x' }, makeContext('tool-3'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.eventQueue[0].data).toMatchObject({ toolName: 'Bash' });
    expect(session.pendingInteractions.has('tool-3')).toBe(true);
  });

  // An edit tool only reaches `canUseTool` under `acceptEdits` when the CLI
  // escalated it — its own engine already auto-allowed every write inside the
  // allowed working directories, so what arrives here failed that check
  // ("Path is outside allowed working directories"). Auto-accepting it would
  // rubber-stamp the escape: `~/.ssh/authorized_keys` is the concrete case.
  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])(
    'raises an approval card for the escalated edit-family tool %s in acceptEdits mode',
    async (toolName) => {
      const session = makeSession('acceptEdits');
      const canUseTool = createCanUseTool(session, noopLog);

      const result = canUseTool(
        toolName,
        { file_path: '/Users/someone/.ssh/authorized_keys' },
        makeContext('tool-e')
      );
      const settled = await Promise.race([
        result.then(() => 'settled' as const),
        Promise.resolve('pending' as const),
      ]);

      expect(settled).toBe('pending');
      expect(session.eventQueue).toHaveLength(1);
      expect(session.eventQueue[0].type).toBe('approval_required');
      expect(session.pendingInteractions.has('tool-e')).toBe(true);
    }
  );

  it('auto-allows a non-safe tool in bypassPermissions mode', async () => {
    const session = makeSession('bypassPermissions');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-4'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.eventQueue).toHaveLength(0);
    expect(session.pendingInteractions.size).toBe(0);
  });

  // Power flows downstream, never up (spec `trusted-by-default-flip` §4). Under
  // a ceiling the turn runs at a mode that calls back for every tool, and below
  // Full the callback answers from the TURN's mode.
  it('routes a non-safe tool to approval in an Accept edits session held to the runtime default', async () => {
    const session = {
      ...makeSession('acceptEdits'),
      turnPermissionCeiling: 'runtime-default' as const,
    };
    const canUseTool = createCanUseTool(session, noopLog);

    void canUseTool(NON_SAFE_TOOL, { command: 'rm -rf build' }, makeContext('tool-ceiling'));
    await vi.waitFor(() => expect(session.pendingInteractions.has('tool-ceiling')).toBe(true));
  });

  // DOR-3394, the product owner's rule: a chat SET to Full autonomy asks nobody
  // anything. Was: this same session raised a card (DOR-3204's held turn).
  it('allows a non-safe tool in a bypass session held to the runtime default, with no card', async () => {
    const session = {
      ...makeSession('bypassPermissions'),
      turnPermissionCeiling: 'runtime-default' as const,
    };
    const canUseTool = createCanUseTool(session, noopLog);

    expect(
      await canUseTool(NON_SAFE_TOOL, { command: 'rm -rf build' }, makeContext('tool-ceiling'))
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -rf build' } });
    expect(session.eventQueue).toHaveLength(0);
  });

  // DOR-3204: a stranger's turn must not write a standing rule into the folder.
  it('offers no Always allow on a held turn’s card, and still does on any other', async () => {
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'python3 *' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ] as PermissionUpdate[];
    const MARKED = { asks: 'always', reach: 'edit', outsider: true } as const;
    const raised = async (held: false | 'stranger' | 'marked') => {
      const session = {
        ...makeSession('default'),
        ...(held === 'stranger' ? { turnPermissionCeiling: 'runtime-default' as const } : {}),
        ...(held === 'marked' ? { turnPermissionCeiling: MARKED } : {}),
      };
      void createCanUseTool(session, noopLog)(
        NON_SAFE_TOOL,
        { command: 'python3 -c 1' },
        { ...makeContext('tool-held'), suggestions }
      );
      await vi.waitFor(() => expect(session.eventQueue).toHaveLength(1));
      return [session.eventQueue[0], session.pendingInteractions.get('tool-held')] as const;
    };
    for (const held of ['stranger', 'marked'] as const) {
      const [heldEvent, heldPending] = await raised(held);
      expect(heldEvent).toMatchObject({
        type: 'approval_required',
        data: { hasSuggestions: false },
      });
      expect(heldPending?.type === 'approval' && heldPending.suggestions).toEqual([]);
    }
    const [freeEvent] = await raised(false);
    expect(freeEvent).toMatchObject({ data: { hasSuggestions: true } });
  });

  // DOR-3390: a turn that carries an outsider's words on runs at its own level, and below Full
  // only its shell goes to a person, with no standing rule offered. At Full nothing does
  // (DOR-3394; this test asked at Full until then).
  it('asks about Bash below Full in a turn that carries an outsider’s words on, never at Full', async () => {
    const CARRIED = { asks: 'never', reach: 'everything', outsider: true } as const;
    const suggestions = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'python3 *' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ] as PermissionUpdate[];
    const atFull = { ...makeSession('bypassPermissions'), turnPermissionCeiling: CARRIED };
    expect(
      await createCanUseTool(atFull, noopLog)(
        NON_SAFE_TOOL,
        { command: 'python3 -c 1' },
        makeContext('tool-full')
      )
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'python3 -c 1' } });
    expect(atFull.eventQueue).toHaveLength(0);
    const session = { ...makeSession('acceptEdits'), turnPermissionCeiling: CARRIED };
    const canUseTool = createCanUseTool(session, noopLog);
    void canUseTool(
      NON_SAFE_TOOL,
      { command: 'python3 -c 1' },
      { ...makeContext('tool-shell'), suggestions }
    );
    await vi.waitFor(() => expect(session.pendingInteractions.has('tool-shell')).toBe(true));
    const pending = session.pendingInteractions.get('tool-shell');
    expect(pending?.type === 'approval' && pending.suggestions).toEqual([]);
    // The same session with no mark at all runs its shell unasked.
    const free = makeSession('bypassPermissions');
    expect(
      await createCanUseTool(free, noopLog)(NON_SAFE_TOOL, { command: 'ls' }, makeContext('t2'))
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  // DOR-3390, Security's M-A and M-C: the hook sends an edit to git's files or the agent's own
  // here below Full. At Full (DOR-3394) neither asks; this test asked at Full until then.
  it('asks about an edit to .git or .dork below Full in a carried turn, and not at Full', async () => {
    const CARRIED = { asks: 'never', reach: 'everything', outsider: true } as const;
    const session = { ...makeSession('acceptEdits'), turnPermissionCeiling: CARRIED };
    const canUseTool = createCanUseTool(session, noopLog);
    void canUseTool('Edit', { file_path: '/agents/ana/.git/config' }, makeContext('tool-git'));
    void canUseTool('Write', { file_path: '/agents/ana/.dork/SOUL.md' }, makeContext('tool-soul'));
    await vi.waitFor(() => expect(session.pendingInteractions.has('tool-git')).toBe(true));
    await vi.waitFor(() => expect(session.pendingInteractions.has('tool-soul')).toBe(true));
    const atFull = { ...makeSession('bypassPermissions'), turnPermissionCeiling: CARRIED };
    expect(
      await createCanUseTool(atFull, noopLog)(
        'Write',
        { file_path: '/agents/ana/.dork/SOUL.md' },
        makeContext('t-full')
      )
    ).toEqual({ behavior: 'allow', updatedInput: { file_path: '/agents/ana/.dork/SOUL.md' } });
    const free = makeSession('bypassPermissions');
    expect(
      await createCanUseTool(free, noopLog)(
        'Edit',
        { file_path: '/agents/ana/.git/config' },
        makeContext('t3')
      )
    ).toEqual({ behavior: 'allow', updatedInput: { file_path: '/agents/ana/.git/config' } });
  });

  it('auto-allows read-only tools inside its folder even in auto mode', async () => {
    const session = { ...makeSession('auto'), cwd: '/tmp' };
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool('Read', { file_path: '/tmp/x' }, makeContext('tool-5'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/x' } });
    expect(session.eventQueue).toHaveLength(0);
  });

  // SDK 0.3.274 provenance. The name `mcp__dorkos__mesh_list` is not proof the
  // call is DorkOS's: a project `.mcp.json` server named `dorkos` exposes the
  // same names, and only `source: 'sdk'` (which only the host can register)
  // says the in-process server is serving it.
  describe('MCP server provenance on the safe list', () => {
    const MESH_LIST = 'mcp__dorkos__mesh_list';

    it("auto-allows a DorkOS tool served by the host's own in-process server", async () => {
      const session = makeSession('default');
      const result = await createCanUseTool(session, noopLog)(
        MESH_LIST,
        {},
        { ...makeContext('prov-sdk'), mcpServer: { name: 'dorkos', source: 'sdk' } }
      );
      expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
      expect(session.eventQueue).toHaveLength(0);
    });

    it('keeps auto-allowing when the CLI sends no provenance (older CLIs, built-ins)', async () => {
      const session = makeSession('default');
      const result = await createCanUseTool(session, noopLog)(MESH_LIST, {}, makeContext('prov-0'));
      expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
    });

    it.each(['project', 'user', 'plugin', 'a-source-nobody-has-seen'])(
      'asks for the same name served by a configured server (%s)',
      async (source) => {
        const session = makeSession('default');
        const pending = createCanUseTool(session, noopLog)(
          MESH_LIST,
          {},
          { ...makeContext(`prov-${source}`), mcpServer: { name: 'dorkos', source } }
        );
        const settled = await Promise.race([
          pending.then(() => 'settled' as const),
          Promise.resolve('pending' as const),
        ]);
        expect(settled).toBe('pending');
        expect(session.eventQueue[0].type).toBe('approval_required');
      }
    );
  });

  // DOR-782. A stale comment in message-sender claimed `canUseTool` never sees
  // subagent tool use, and a turn killed by the stall watchdog was misdiagnosed
  // on the strength of it. At SDK 0.3.177 a foreground `Task` subagent's tool
  // calls arrive on THIS callback, tagged with `agentID` (sdk.d.ts `CanUseTool`).
  // This pins that DorkOS's gate treats such a call like any other — it raises a
  // real card, which is what pauses the watchdog. If a future SDK genuinely
  // stops routing subagent calls here, this test is the thing that should be
  // re-read, but only a live SDK change can make it red.
  it('raises a normal approval card for a call made from inside a subagent', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, {
      ...makeContext('subagent-tool-1'),
      agentID: 'agent_01HZ',
    } as ToolApprovalContext);
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('subagent-tool-1')).toBe(true);
  });

  // DOR-1229 and DOR-1265, both directions. A room triggers a turn INTO THE DARK
  // — nobody holds that session's stream — under `default`, the strictest mode,
  // so a card raised for the agent's own room verbs is a card nobody is
  // positioned to answer: measured live on 2026-08-16, `search_room_history`
  // asked at 15s and the turn made no further progress until the interaction
  // window auto-denied it ten minutes later. `relay_notify_user` joined the set
  // on the same measurement day for the same reason (DOR-1265): asked in a
  // channel to send the operator a note, the agent parked on `awaiting_approval`
  // and no message was ever sent. It qualifies because it can only speak inside a
  // scope the operator configured and switched on — their own DorkOS DM, or a
  // binding with "Agent can start conversations" enabled, which may cover a
  // group, somebody else's chat, or (chat filter left empty, the default) every
  // chat that has messaged that adapter. That is a bound on the SCOPE, not a
  // promise that only the operator reads it, and the card that went away was the
  // per-call one, never the setup consent.
  //
  // But the auto-allow is only honest while the session HAS an identity. Without
  // one, `callerAuthor` falls back to the person who owns the install — who sees
  // every room on the machine, their DMs included, and posts as a human at
  // cascade depth zero. So both halves are pinned, per verb, by name: a shrinking
  // safe-list or a dropped gate is red here rather than quiet.
  const OWNER_FACING_VERBS: [string, Record<string, unknown>][] = [
    ['mcp__dorkos__post_to_room', { roomId: 'room-1', text: 'on it' }],
    ['mcp__dorkos__react_to_room_entry', { roomId: 'room-1', entryId: 'e-1', emoji: '🎉' }],
    ['mcp__dorkos__read_room_history', { roomId: 'room-1' }],
    ['mcp__dorkos__search_room_history', { roomId: 'room-1', query: 'deploy' }],
    ['mcp__dorkos__relay_notify_user', { message: 'the deploy finished' }],
    // `memory_write` joins them for a different reason, spelled out in
    // `interactive-handlers.ts` and in the gate test's own argument: it is
    // jailed to the caller's own capped file, has no execution semantics, and
    // without an identity there IS no file — the handler answers `no-agent`.
    // Both halves are pinned here anyway, because the gate must not decide a
    // call is harmless on the strength of another layer refusing it.
    ['mcp__dorkos__memory_write', { action: 'add', text: 'the operator ships on Fridays' }],
  ];

  /** A session whose cwd hosts a registered agent, as the resolver reports it. */
  const withIdentity = () => Promise.resolve({ identity: { agentPath: '/agents/ada' } });
  /** A plain project directory: the resolver names nobody. */
  const withoutIdentity = () => Promise.resolve(undefined);

  it.each(OWNER_FACING_VERBS)(
    'lets an agent-identified session use its own owner-facing verb %s without a card nobody can answer',
    async (toolName, input) => {
      const session = makeSession('default');
      const canUseTool = createCanUseTool(session, noopLog, undefined, withIdentity);

      const result = await canUseTool(toolName, input, makeContext(`owner-facing-${toolName}`));

      expect(result).toEqual({ behavior: 'allow', updatedInput: input });
      expect(session.eventQueue).toHaveLength(0);
      expect(session.pendingInteractions.size).toBe(0);
    }
  );

  it.each(OWNER_FACING_VERBS)(
    // Why a card, per verb: a rooms verb from a nameless session acts as the
    // OWNER, and a note has no sender to be from. The gate does not distinguish
    // them, and should not — it asks whenever it cannot say who is calling.
    'still raises a card for %s when the session names nobody',
    async (toolName, input) => {
      const session = makeSession('default');
      const canUseTool = createCanUseTool(session, noopLog, undefined, withoutIdentity);

      const result = canUseTool(toolName, input, makeContext(`anon-${toolName}`));
      const settled = await Promise.race([
        result.then(() => 'settled' as const),
        Promise.resolve('pending' as const),
      ]);

      expect(settled).toBe('pending');
      expect(session.eventQueue[0].type).toBe('approval_required');
      expect(session.pendingInteractions.has(`anon-${toolName}`)).toBe(true);
    }
  );

  it.each(OWNER_FACING_VERBS)(
    // A session standing where some agent works but that cannot be tied to the
    // turn's agent answers `agentIdentityPresented` with NO identity (DOR-2091).
    // That is an answer, but it names nobody, so it must ask — a gate that
    // tested "any answer" would wave the call through. Seeded: reverting
    // `hasAgentIdentity` to `!== undefined` reddens every row.
    'still raises a card for %s when the session is a machine nobody can name',
    async (toolName, input) => {
      const session = makeSession('default');
      const canUseTool = createCanUseTool(session, noopLog, undefined, () =>
        Promise.resolve({ agentIdentityPresented: true })
      );

      const result = canUseTool(toolName, input, makeContext(`refused-${toolName}`));
      const settled = await Promise.race([
        result.then(() => 'settled' as const),
        Promise.resolve('pending' as const),
      ]);

      expect(settled).toBe('pending');
      expect(session.eventQueue[0].type).toBe('approval_required');
    }
  );

  it('asks rather than skipping the card when the identity lookup throws', async () => {
    // Fail-closed: the fallback caller on the other side of these verbs is the
    // person who owns the install, so "could not tell" must never mean "allow".
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog, undefined, () =>
      Promise.reject(new Error('the agent index is gone'))
    );

    const result = canUseTool(
      'mcp__dorkos__read_room_history',
      { roomId: 'r' },
      makeContext('e-1')
    );
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue[0].type).toBe('approval_required');
  });
});
