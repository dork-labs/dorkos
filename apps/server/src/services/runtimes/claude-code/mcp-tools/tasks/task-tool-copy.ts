/**
 * What the `tasks_*` tools say to an agent: the notes a reply carries and the
 * descriptions its arguments advertise. Split from `task-tools.ts`, which holds
 * the handlers, so the words and the behavior can each be read on their own.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-copy
 */
/**
 * What `tasks_create` tells an agent once the schedule is parked.
 *
 * The old wording said only that the status was `pending_approval`, which is
 * true and useless: a model reads it, reports "created the schedule", and ends
 * the turn — leaving a person who was never told anything to discover the
 * approval on their own. That is the failure this text exists to fix
 * (DOR-1570): the operator had to ASK an agent to open the Tasks panel before
 * they found out something was waiting on them.
 *
 * So it asks for the one thing only the agent can do, which is say so out loud.
 * DorkOS does the rest — the bell, the desktop banner, and the phone ping after
 * the escalation delay all fire on their own.
 */
export const PARKED_SCHEDULE_NOTE =
  'This schedule will NOT run until the person approves it. Tell them so in your reply — ' +
  'name the scheduled task and say it is waiting on them. Do not end the turn as if the work ' +
  'were done.';

/**
 * What `tasks_create` tells an agent whose schedule was armed without asking,
 * because the install is Trusted (ADR 261006-225605).
 *
 * DorkOS has already told the person (`schedule.armed_by_agent`, with Pause),
 * so this asks only for the plain report a co-worker would give.
 */
export const ARMED_SCHEDULE_NOTE =
  'This schedule is live and will run on its own. DorkOS has told the person, and they can ' +
  'pause it any time. Say in your reply what you scheduled and when it runs.';

/**
 * What `tasks_update` tells an agent whose edit to what an approved schedule
 * does has stopped it (DOR-1625 review, DOR-2313).
 *
 * A person's approval is keyed on the schedule's CONTENT — the prompt, the
 * cron and, since DOR-2307, the timezone (`scheduleContentKey`) — so changing
 * any of them means nobody has read this piece of work. DorkOS parks the
 * schedule in the same call (`TaskApprovals.settleApprovedWorkChange`), so the
 * schedule this tool hands back already says `pending_approval`. An agent that
 * read only the status could still report "updated the schedule" and end the
 * turn, leaving a person to discover a stopped schedule on their own, so the
 * reply says what the edit cost. Re-issuing the approval here instead is not an
 * option: only a caller that cleared the agent bar may do that.
 *
 * Worded like {@link PARKED_SCHEDULE_NOTE}, and for the same reason: DorkOS
 * raises the approval on its own, and the one thing only the agent can do is
 * say so out loud. {@link TIMING_REAPPROVAL_NOTE} is its sibling for a change
 * to when the schedule runs alone.
 */
export const REAPPROVAL_NOTE =
  'This changed what an approved schedule does, so the person has to approve it again. DorkOS ' +
  'has already stopped it and put it in front of them — your change is saved, it just will not ' +
  'run until they say yes. Tell them so in your reply: name the scheduled task and say it is ' +
  'waiting on them. Do not end the turn as if the work were done.';

/**
 * What `tasks_update` tells an agent whose change to WHEN an approved schedule
 * runs has stopped it (DOR-2302, DOR-2313).
 *
 * A sibling of {@link REAPPROVAL_NOTE} rather than a reuse, because the agent
 * repeats it to a person and it should name what changed.
 */
export const TIMING_REAPPROVAL_NOTE =
  'This changed when an approved schedule runs, so the person has to approve it again. DorkOS ' +
  'has already stopped it and put it in front of them — your change is saved, it just will not ' +
  'run until they say yes. Tell them so in your reply: name the scheduled task and say it is ' +
  'waiting on them. Do not end the turn as if the work were done.';

/**
 * The description `tasks_update` gives the `resetTiming` argument (DOR-2302).
 *
 * Agent-writable like `cron`, and approved like `cron`: going back to the
 * package's timing changes when the work runs, so a person approves it again.
 */
export const RESET_TIMING_DESCRIPTION =
  "Send true to put a schedule that came with an installed package back on the package's own " +
  'timing, undoing a cron or timezone set here. Send it on its own, not together with cron or ' +
  'timezone. If it changes when an approved schedule runs, the person has to approve it again.';

/**
 * The extra sentence for an agent that is in a live DorkOS session, where it can
 * put the approval in front of the person rather than only describing it.
 *
 * Only ever appended when a session actually resolved. `control_ui` needs an
 * attached interactive session and does not exist on the sessionless external
 * `/mcp` server, so telling an agent there to call it would be an instruction
 * that can only fail. It is also not auto-allowed, so this is worded as
 * something to offer, never as something that will happen.
 */
export const PARKED_SCHEDULE_SURFACE_HINT =
  'If it helps them decide, you can open the Schedules panel for them with ' +
  "control_ui({ action: 'open_panel', panel: 'tasks' }).";

/**
 * The description `tasks_create` gives the `target` argument.
 *
 * Required, and that is the fix rather than an inconvenience (DOR-1568). The tool
 * never asked where a task should live, so it wrote no file and set no owner: the
 * row landed with `filePath: ''` and `agentId: null`, the reconciler skipped it
 * because there was nothing on disk to reconcile, and its runs happened in
 * whatever directory the server itself was started in. There is no safe default
 * to fall back on — `global` would quietly file an agent's own work where it does
 * not belong — so the caller says, or nothing is created.
 */
export const TARGET_DESCRIPTION =
  'Where this scheduled task lives. Give your own agent id to file it under yourself — it then ' +
  'runs in your folder, with your files — or "global" for a scheduled task that belongs to no ' +
  'agent and runs in the DorkOS data folder. Required: DorkOS will not guess, because a scheduled ' +
  'task filed in the wrong place runs against the wrong files.';

/**
 * The description both tools give the `agentId` argument, which neither accepts.
 *
 * Declared for the reason {@link REFUSED_PERMISSION_MODE_DESCRIPTION} is declared:
 * an argument the schema does not name is STRIPPED by the SDK before the handler
 * runs, so the agent that reached for it is told its call worked. It is the field
 * an agent actually reaches for when it wants a task to be its own — the reported
 * failure was exactly that — so it is worth answering rather than swallowing.
 */
export const REFUSED_AGENT_ID_DESCRIPTION =
  'Not a field on a scheduled task write. Use `target` on `tasks_create` to say which agent a ' +
  'scheduled task belongs to. Send this and DorkOS refuses the whole call and changes nothing.';

/**
 * The description `tasks_update` gives the `target` argument, which it refuses.
 *
 * Same mechanism as {@link REFUSED_AGENT_ID_DESCRIPTION}: an update cannot move a
 * task between agents, because the task IS a file in one agent's folder, and a
 * silent strip told callers otherwise.
 */
export const REFUSED_UPDATE_TARGET_DESCRIPTION =
  'Not something an update can change. A scheduled task is filed under one agent when it is ' +
  'created and stays there. Send this and DorkOS refuses the whole call and changes nothing — ' +
  'to move a scheduled task, delete it and create it again with the target you want.';

/**
 * The description both tools give the `sticky` argument (DOR-1571).
 *
 * Agent-writable: it chooses a run's behavior, not its power. Off (the default)
 * is the isolated-per-run behavior; on makes every run resume one lasting session
 * so the agent keeps context across runs.
 */
export const STICKY_DESCRIPTION =
  'Whether every run picks up the SAME session instead of starting fresh. Off by default: each ' +
  'run is its own conversation and remembers nothing from last time. Turn it on for a task that ' +
  'should build on the run before it — "since I last ran, here is what changed".';

/**
 * The description both tools give the `runtime` argument (DOR-1615).
 *
 * Agent-writable: it chooses WHICH backend does the work, not how much power the
 * run has — and a caller that can already write the `prompt` can do far more
 * than pick a runtime. Omitting it is the ordinary case and the better default.
 */
export const RUNTIME_DESCRIPTION =
  'Which agent runtime the scheduled task runs on — "claude-code", "codex" or "opencode". ' +
  "Leave it out and it runs on whatever the task's agent runs on, which is almost always " +
  'what you want. A runtime that is not turned on here fails the run rather than quietly ' +
  'running somewhere else.';

/**
 * The description both tools give the `model` argument (DOR-1347).
 *
 * Deliberately unvalidated at write, exactly as an agent's own manifest model
 * is: the catalog is remote, a runtime can be disconnected while somebody edits,
 * and a name nothing offers is reported when the run happens.
 */
export const MODEL_DESCRIPTION =
  'Which model the scheduled task runs on, written the way the chosen runtime names it ' +
  '("sonnet", "gpt-5.5", "anthropic/claude-sonnet-4-5"). Leave it out to use the agent\'s own ' +
  "model, then this DorkOS's default. A name the runtime does not offer is reported when the " +
  'task runs, not now.';

/** The description both tools give the `effort` argument — how hard the model thinks. */
export const EFFORT_DESCRIPTION =
  "How hard the model thinks during each run. Leave it out to use the agent's own setting, " +
  "then this DorkOS's default. A runtime that has no such setting ignores it.";

/**
 * The description both tools give the `account` argument — which Claude account
 * (and so whose subscription) a run starts on (DOR-2384).
 */
export const ACCOUNT_DESCRIPTION =
  'Which Claude account the scheduled task runs on, by its id in DorkOS. Leave it out to use ' +
  "the agent's own account, then the default. Only Claude Code runs use it. A schedule that " +
  'keeps one conversation stays on the account its conversation started on.';

/** The description `tasks_create` gives the `reason` argument. */
export const REASON_DESCRIPTION =
  'Why this schedule should exist, in your own words. The person reads it on the schedule, ' +
  'and decides on it when DorkOS asks them first.';

/**
 * The description both servers give the `permissionMode` argument (DOR-504).
 *
 * The argument stays ADVERTISED on purpose, and it is worth being explicit about
 * why, because deleting it looks tidier and is worse. The MCP SDK parses a call
 * against the advertised schema before the handler runs, so an argument this
 * schema does not declare is STRIPPED on the way in — the agent's other fields
 * would land, its `permissionMode` would evaporate, and it would be told the
 * whole call succeeded. That is the silent partial write this guard exists to
 * prevent. Declaring the argument is what lets the handler see it and refuse the
 * call whole, naming the field.
 *
 * So the field no longer lies about what it does: it says it is refused, and it
 * is refused, on both tools and both servers.
 */
export const REFUSED_PERMISSION_MODE_DESCRIPTION =
  'Not yours to set. A scheduled task runs later with nobody watching, so the person chooses ' +
  'how much it may do without asking. Send this and DorkOS refuses the whole call and changes ' +
  'nothing — leave it out, and ask the person to set it on the task in DorkOS.';

/**
 * The description both servers give the `status` argument (DOR-504).
 *
 * Declared for exactly the reason {@link REFUSED_PERMISSION_MODE_DESCRIPTION} is,
 * and it was missed on the first pass: `status` was operator-only in the policy
 * but absent from this tool's schema, so the SDK stripped it and the call
 * reported SUCCESS with the rest of the fields applied. Nothing could reach the
 * store either way, so it was never an escalation — but "we refuse the call
 * whole" has to be true of every operator-only field, or the sentence is not
 * worth anything on the ones where it matters.
 *
 * On BOTH tools, including `tasks_create`, where `status` is not a meaningful
 * argument at all (the store hardcodes it, then the handler parks it). Declaring
 * it there anyway is not padding: the seeded `scheduling-tasks` skill tells agents
 * DorkOS refuses the whole call for either field on either tool, and a field that
 * is silently stripped instead makes that sentence false. The alternative was to
 * narrow the sentence to one tool-and-field pairing, which is a rule nobody will
 * hold in their head. The text below reads for both, and at create time it is the
 * best moment to say a new task waits for approval.
 */
export const REFUSED_STATUS_DESCRIPTION =
  'Not yours to set. Moving a task to `active` IS a person approving it. Send this and DorkOS ' +
  'refuses the whole call and changes nothing. A task waiting at `pending_approval` waits for ' +
  'the person: tell them, and let them approve it in DorkOS. To turn a task on or off, use ' +
  '`enabled` instead.';
