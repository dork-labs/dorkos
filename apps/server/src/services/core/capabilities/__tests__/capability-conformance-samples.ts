/**
 * The sample input each capability gets in the conformance suite
 * (`capability-conformance.test.ts`): one per id whose input `{}` would not
 * parse, chosen so the call reaches its gate or its handler. Kept beside the
 * suite so the suite file stays under its line budget.
 *
 * @module services/core/capabilities/__tests__/capability-conformance-samples
 */

/** What the samples need from the suite's own world. */
export interface ConformanceSampleWorld {
  /** The sandbox folder the operator tools may touch. */
  sandboxCwd: string;
  /** The room the suite creates, by id. */
  roomId: string;
  /** The same room, by slug. */
  roomSlug: string;
}

/**
 * The sample inputs, keyed by capability id.
 *
 * @param fixture - The suite's sandbox folder and room.
 * @returns The inputs for `capabilityConformance`'s `sampleInputs`.
 */
export function conformanceSampleInputs(
  fixture: ConformanceSampleWorld
): Record<string, Record<string, unknown>> {
  return {
    'operator.update_agent': { cwd: fixture.sandboxCwd, displayName: 'Conformance' },
    // The tasks tools (C9a): the smallest valid call of each; the registry composes no task
    // store here, so each answers that Tasks is off, or its gate refuses it first.
    'tasks.create_task': { name: 'Conformance', prompt: 'x', reason: 'conformance' },
    'tasks.update_task': { id: 'conformance-task' },
    'tasks.delete_task': { id: 'conformance-task' },
    'tasks.get_run_history': { schedule_id: 'conformance-task' },
    // Destructive, and `nopeContent` is REQUIRED — a fixture without it fails the
    // Zod parse before the gate ever runs, which would read as "the gate did not
    // refuse this" (DOR-1698).
    'operator.update_agent_boundaries': { cwd: fixture.sandboxCwd, nopeContent: 'Never do that.' },
    // Destructive, and `path` and `content` are required for the same reason
    // (DOR-4266).
    'operator.update_agent_config': {
      cwd: fixture.sandboxCwd,
      path: 'settings.json',
      content: '{}',
    },
    'operator.config_patch': { patch: { ui: { sidebar: { collapsed: true } } } },
    // Both sidebar verbs need a PARSEABLE fixture — `group` and `items` are
    // required, so `{}` would raise a ZodError and read as a wiring failure. The
    // section named here does not exist and `createIfMissing` is absent, so each
    // reaches its handler and answers the structured SIDEBAR_GROUP_NOT_FOUND:
    // wired and reachable, which is what this suite asks, without writing to the
    // config store the whole suite shares (DOR-2055).
    'operator.sidebar_add_to_group': {
      group: 'no-such-conformance-section',
      items: [{ kind: 'agent', path: fixture.sandboxCwd }],
    },
    'operator.sidebar_remove_from_group': {
      group: 'no-such-conformance-section',
      items: [{ kind: 'agent', path: fixture.sandboxCwd }],
    },
    // The audit reads need their required ids to parse; each then answers its
    // own structured NOT_FOUND / TRANSCRIPT_PRIVATE from the stub log.
    'audit.get': { id: 'no-such-conformance-event' },
    'audit.account_timeline': { accountId: 'no-such-conformance-account' },
    'audit.transcript_read': { sessionId: 'no-such-conformance-session' },
    'marketplace.get': { name: 'nonexistent-conformance-pkg' },
    // Nothing is installed in the sandbox, so the handler answers its own `MARKETPLACE_NOT_FOUND`.
    'marketplace.read_installed': { name: 'nonexistent-conformance-pkg' },
    'marketplace.recommend': { context: 'observability for a next.js app' },
    'marketplace.install': { name: 'nonexistent-conformance-pkg' },
    'marketplace.uninstall': { name: 'nonexistent-conformance-pkg' },
    // Destructive with a required `path`: parseable, so the gate (not a
    // ZodError) answers. A call past the gate meets the stub's structured
    // refusal.
    'marketplace.link': { path: '/nonexistent-conformance-folder' },
    'marketplace.create_package': {
      name: 'conformance-pkg',
      type: 'plugin',
      description: 'A conformance fixture package.',
    },
    'connector.recommend': { service: 'gmail' },
    // Every mcp verb needs a PARSEABLE fixture: the destructive writes so the gate
    // (not a ZodError) refuses them, and the observe/act verbs so they reach the
    // handler and answer with a structured AGENT_NOT_FOUND (the locator has no
    // agent). All are keyed by agent id (spec §5).
    // No identity in a conformance invocation, so the handler answers its own
    // `no-agent` refusal — wired and reachable, which is what this suite asks.
    'memory.write': { action: 'add', text: 'a conformance note' },
    // The pause verbs reach the (stub) pause service with a parseable id.
    'agent.pause': { agentId: 'conformance-agent' },
    'agent.resume': { agentId: 'conformance-agent' },
    // A room the operator is in, so the link reaches the real rooms service and opens it.
    'link.resolve': { uri: `dork:room:${fixture.roomId}` },
    // No such to-do, so the handler answers its own `TODO_NOT_FOUND`.
    'todos.view_card': { id: 'conformance-no-such-todo' },
    // The chat reads (DOR-4978): an id that is not a chat id, so each answers its own
    // `CHAT_ID_INVALID` without reading a store.
    'sessions.get_runtime_type': { id: 'conformance-not-a-chat-id' },
    'sessions.get_settings': { id: 'conformance-not-a-chat-id' },
    // No Tasks running in conformance, so the handler answers its own `TASKS_UNAVAILABLE`.
    'tasks.view_run': { id: 'conformance-no-such-run' },
    // A person's writes, valid input for each; the person-only door refuses the anonymous call.
    'todos.add_as_person': { what: 'Conformance', assignee: { kind: 'person', account: 'owner' } },
    'todos.change_as_person': { id: 'conformance-no-such-todo', state: 'kept' },
    'todos.change_promise': { id: 'conformance-no-such-promise', state: 'kept' },
    'todos.confirm_promise': { id: 'conformance-no-such-promise', answer: 'yes' },
    // A folder that is not there, so the handler answers its own `FOLDER_MISSING`.
    'directory.browse': { path: '/conformance-no-such-folder' },
    // Paths outside the boundary, so each answers its own path refusal.
    'diff.baseline': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
    'diff.advance_baseline': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
    'diff.pending': { cwd: '/conformance', sessionId: 'conformance-chat' },
    'diff.revert': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
    // The file browser (DOR-4978): the read refuses a folder outside the boundary; each
    // person-only door refuses the anonymous call before it runs.
    'files.read_text': { cwd: '/conformance-no-such-folder', path: 'a.md' },
    'files.save': { cwd: '/conformance-no-such-folder', path: 'a.md', content: 'x' },
    'files.create': { cwd: '/conformance-no-such-folder', path: 'a.md', type: 'file' },
    'files.delete': { cwd: '/conformance-no-such-folder', path: 'a.md' },
    'files.rename': { cwd: '/conformance-no-such-folder', from: 'a.md', to: 'b.md' },
    'files.reveal': { cwd: '/conformance-no-such-folder', path: 'a.md' },
    // The agents' queue tools, parseable so the gate or the handler answers:
    // with no identity each refuses `NO_AGENT`; the destructive ones meet the gate.
    'work-queue.add': { title: 'Conformance', prompt: 'A conformance probe.' },
    'work-queue.remove': { id: 'conformance-item' },
    'work-queue.read_agent': { agentId: 'conformance-agent' },
    'work-queue.configure': {
      before: { enabled: false, target: 1, dailyStartCap: 1 },
      changes: { enabled: true },
    },
    'work-queue.reorder': { itemIds: ['conformance-item'] },
    'work-queue.requeue': { id: 'conformance-item' },
    // No workspace subsystem here, so the pin answers its own `WORKSPACE_NOT_FOUND`.
    'workspaces.pin': { id: 'conformance-workspace', pinned: true },
    // Outside a beat, so the handler answers its own `NOT_A_BEAT` refusal.
    'heartbeat.end_beat': { summary: 'A conformance beat.' },
    // A valid answer; the person-only door refuses the anonymous call before it runs.
    'heartbeat.choose_triage_credits': { useCredits: false },
    // The runtime setup reads, each with its required field; the person-only door refuses
    // the anonymous call before it runs.
    'runtimes.account_usage': { runtime: 'claude-code' },
    'runtimes.key_status': { type: 'claude-code' },
    // One agent's reads and a persona move on `/api/agents/*` (DOR-4978). The person-only
    // ones refuse the anonymous call before they run; the permission reads answer that
    // DorkOS is still starting (no reader set).
    'heartbeat.view_page': { id: 'conformance-agent' },
    'agent.migrate_persona': { path: '/conformance' },
    'agent.current': { path: '/conformance' },
    'permissions.view_agent': { id: 'conformance-agent' },
    'permissions.view_agent_level': { id: 'conformance-agent' },
    // Valid input; each person-only door refuses the anonymous call before it runs.
    'mcp.check_global_args': { args: ['--verbose'] },
    'mcp.add_global_server': {
      name: 'conformance-srv',
      connection: { transport: 'stdio', command: 'npx', args: ['-y', 'conformance-mcp@1.0.0'] },
    },
    'mcp.replace_global_server': {
      server: 'conformance-srv',
      name: 'conformance-srv',
      connection: { transport: 'stdio', command: 'npx', args: ['-y', 'conformance-mcp@1.0.0'] },
    },
    'mcp.remove_global_server': { name: 'conformance-srv' },
    // Behind the account-decision bar: refused before the handler without the mount's proof.
    'connectors.disconnect_impact': { connectionId: 'conformance-connection' },
    'connectors.rename_connection': { connectionId: 'conformance-connection', label: 'Work' },
    'connectors.remove_connection': { connectionId: 'conformance-connection' },
    'connectors.get_sign_in': { flowId: 'conformance-flow' },
    'connectors.get_review': { reviewRequestId: 'conformance-review' },
    'connectors.get_agent_request_sign_in': {
      requestId: 'conformance-request',
      flowId: 'conformance-flow',
    },
    'connectors.stop_every_agent_share': { connectionId: 'conformance-connection' },
    'connectors.leave_agent_out': { connectionId: 'conformance-connection', agentId: 'agent-a' },
    'connectors.list_usage': {},
    'connectors.let_agent_back_in': { connectionId: 'conformance-connection', agentId: 'agent-a' },
    'connectors.answer_agent_request': { requestId: 'conformance-request', decision: 'denied' },
    'connectors.start_agent_request_sign_in': {
      requestId: 'conformance-request',
      providerInstanceId: 'conformance-provider',
    },
    'connectors.list_every_agent_grants': {},
    'connectors.list_agent_connections': { agentId: 'agent-a' },
    'connectors.list_session_connections': { sessionId: 'conformance-session' },
    'connectors.list_reviews': {},
    'connectors.list_exclusions': { connectionId: 'conformance-connection' },
    // Behind the person bar: refused before the handler without the mount's pass.
    'extensions.dismiss_approval': {
      id: 'conformance-ext',
      path: '/x/conformance-ext',
      version: '1.0.0',
    },
    'extensions.remove': { id: 'conformance-ext' },
    'extensions.forget_approval': { id: 'conformance-ext' },
    'extensions.restart': { id: 'conformance-ext' },
    'mcp.check_global_tools': { name: 'conformance-srv' },
    'mcp.undo_global_allow': {
      name: 'conformance-srv',
      agentId: 'conformance-agent',
      rule: 'mcp__conformance-srv',
    },
    // A chat id is required, so `{}` would be a ZodError. With no run record
    // wired here, the handler answers its own `NOT_READY` refusal.
    'runs.chat_runs': { id: '00000000-0000-4000-8000-0000000c0a55' },
    // An agent or chat is required. No agent is registered and no work graph is
    // installed here, so each answers its own `WORK_GRAPH_AGENT_NOT_FOUND` or `NOT_READY`.
    'work-graph.agent_chats': { agentId: '01JCONFORMANCEAGENT0000000' },
    'work-graph.agent_work': { agentId: '01JCONFORMANCEAGENT0000000' },
    'work-graph.chat_tree': { chatId: 'conformance-chat' },
    'work-graph.chat_work': { chatId: 'conformance-chat' },
    'work-graph.work_item_chats': { ref: 'DOR-1' },
    // Anonymous here, so the handler refuses with its own structured error
    // (there is no agent to scope the request to), which is what "wired" means.
    'permissions.request_access': {
      action: 'capabilities.list',
      arguments: {},
      reason: 'a conformance probe',
    },
    // A floor-area action: nothing lets it run without a person's yes, so the
    // gate answers before the handler, which is the wiring this proves.
    'permissions.change': { target: 'everyone', area: 'tasks', state: 'ask' },
    'mcp.list': { agentId: 'conformance-agent' },
    'mcp.add': {
      agentId: 'conformance-agent',
      name: 'conformance-srv',
      connection: { transport: 'stdio', command: 'node', args: [], env: {} },
    },
    'mcp.import': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.update': { agentId: 'conformance-agent', name: 'conformance-srv', enabled: false },
    'mcp.remove': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.enable': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.disable': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.test': { agentId: 'conformance-agent', name: 'conformance-srv' },
    // Sign-in verbs (DOR-942): act-tier, so they reach the handler and answer with
    // a structured error — the mcpDeps here carry no OAuth engine, so signin fails
    // as SIGNIN_UNAVAILABLE after the agent lookup, and poll as the same.
    'mcp.signin': { agentId: 'conformance-agent', name: 'conformance-srv' },
    'mcp.poll_signin': { flowId: 'conformance-flow' },
    'mcp.set_client': {
      agentId: 'conformance-agent',
      name: 'conformance-srv',
      clientId: 'conformance-client',
    },
    // The rooms verbs, against the harness room above. No identity travels in a
    // conformance invocation and login is off, so `callerAuthor` resolves the
    // operator — who is a member of that room — and each verb reaches its handler
    // and really runs. A verb that stopped being wired would raise an
    // unstructured throw here rather than a `RoomError`, which is the failure
    // this suite is asking about.
    'rooms.post': { roomId: fixture.roomId, text: 'a conformance message' },
    'rooms.react': { roomId: fixture.roomId, entryId: 'conformance-entry', emoji: '👍' },
    // The two repo verbs, against `roomMerges` above. The conformance channel has
    // no files, so both reach the real service and answer the structured
    // `NOT_A_PROJECT_ROOM` — which is what "wired" looks like here. A merge that
    // could really run would need a git repo on disk, and this suite is asking
    // whether the verb is reachable, not whether git works.
    'rooms.merge': { roomId: fixture.roomId, summary: 'a conformance merge' },
    'rooms.set_up_files': { roomId: fixture.roomId },
    'rooms.repo_status': { roomId: fixture.roomId },
    'rooms.handoff_status': { handoffId: 'a-conformance-hand-off' },
    'rooms.read_history': { roomId: fixture.roomId, limit: 5 },
    'rooms.search_history': { roomId: fixture.roomId, query: 'conformance' },
    'rooms.list_member_rooms': {},
    'rooms.search_member_rooms': { query: 'conformance' },
    'rooms.get_room': { roomId: fixture.roomId },
    // A REAL filter, deliberately. `find_room` would have passed this suite with
    // `{}` too — but only by accident: its no-filter guard answers a typed
    // MISSING_FILTER, which reads as "structured refusal, therefore wired" while
    // never reaching the service at all. Naming the room's own `#slug` makes the
    // invocation do the thing the suite is asking about, and exercises the sigil
    // that `normalizeRoomNameNeedle` strips on the way in.
    'rooms.find_room': { name: `#${fixture.roomSlug}` },
    // The verbs that ARRANGE rooms, in the Rooms permission area. Every one of
    // these must PARSE and then be refused by the PERMISSION, not by a ZodError —
    // the invoke check reads an unstructured throw as a wiring failure. So each
    // fixture is a request that would really run if Rooms were Allowed, and each
    // names the harness room the reads above use.
    //
    // Nothing in this file wires the permission config, and that is the point:
    // unwired, no preset is chosen (Unchanged), where Rooms is Blocked.
    'rooms.create': { kind: 'channel', title: 'Conformance opened' },
    'rooms.add_members': { roomId: fixture.roomId, members: ['@conformance'] },
    'rooms.remove_members': { roomId: fixture.roomId, members: ['@conformance'] },
    'rooms.update': { roomId: fixture.roomId, topic: 'what this room is for' },
    'rooms.leave': { roomId: fixture.roomId },
    'rooms.archive': { roomId: fixture.roomId },
    // The canvas read (DOR-1999), against the same harness room. With no
    // `documentId` it LISTS what is on the table, which is the arm that needs no
    // document to exist — so the verb really runs and answers `{ documents: [] }`
    // rather than a structured refusal that would read as "wired" without ever
    // reaching the service.
    'rooms.read_canvas': { roomId: fixture.roomId },
    // Re-seat (Re-seat P0). The options read reaches the real service, which
    // answers the structured MEMBER_NOT_FOUND for an agent the harness room does
    // not hold; the move, in the Rooms area, is refused by the permission first.
    'rooms.reseat_options': { roomId: fixture.roomId, agentId: 'conformance-agent' },
    'rooms.reseat': { roomId: fixture.roomId, agentId: 'conformance-agent' },
    // The SESSION canvas read (spec `canvas-agent-seat` §1.8). Its input is a
    // document id and nothing else — there is no session argument, which is the
    // whole security property — so the conformance call runs the handler with no
    // session in context and gets the sentence that says so. That is the verb
    // really running: a wiring fault would throw instead.
    'ui.read_canvas_document': { documentId: 'conformance-document' },
    'ui.configure_doc_channel': { documentId: 'conformance-document', channel: { routes: [] } },
    'ui.approve_doc_route': {
      documentId: 'conformance-document',
      routeId: 'route',
      expiresAt: '2026-10-02T00:00:00.000Z',
    },
    'ui.revoke_doc_route': { documentId: 'conformance-document', grantId: 'grant' },
    'ui.send_canvas_event': {
      documentId: 'conformance-document',
      eventId: '00000000-0000-4000-8000-000000000001',
      type: 'task.updated',
      payload: {},
    },
    'ui.patch_canvas_state': {
      documentId: 'conformance-document',
      eventId: '00000000-0000-4000-8000-000000000002',
      expectedStateRev: 0,
      operations: [{ op: 'set', path: '/checked', value: true }],
    },
    // The rest of the `ui` domain (spec `canvas-agent-seat` §5). None of them
    // takes a session argument — the surface supplies that, which is the whole
    // security property — so every one of these runs with no session in context
    // and answers the sentence that says so. That IS the verb really running: a
    // wiring fault would throw instead.
    //
    // Each fixture is a call that would really do something if a window were
    // there, so a schema that stopped advertising an argument reds here too.
    'ui.control': { action: 'show_toast', message: 'conformance', level: 'info' },
    'ui.state': {},
    'ui.read_console': { level: 'error', limit: 5 },
    'ui.read_network': { status: 'failed', limit: 5 },
    'ui.screenshot': {},
    'ui.click': { role: 'button', name: 'Continue' },
    'ui.type': { selector: '#email', text: 'conformance@example.test' },
    'ui.press': { key: 'Enter' },
    'ui.scroll': { to: 'bottom' },
    'ui.wait_for': { text: 'Done', timeoutMs: 1_000 },
    'ui.read_page': {},
    'ui.record_start': {},
    'ui.record_stop': {},
  };
}
