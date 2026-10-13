/**
 * The blocks DorkOS wraps around a person's message before handing it to a
 * runtime — the runtime-neutral agent context (`runtimes/shared/agent-context.ts`),
 * the per-turn `AdditionalContext` entries (ADR-0273, `ContextKind`), OpenCode's
 * `<gen_ui>` and `<room_tools>` preamble, and the `<dork-kickoff>` birth-turn
 * envelope.
 *
 * Listed rather than imported: these tags are written as literals at the seams
 * that build them, there is no shared registry to read, and a conformance suite
 * that imported one adapter's constants would stop being runtime-neutral.
 *
 * The list is therefore best-effort, and safely so: a tag missing from it only
 * makes this half of the check weaker, never wrong. The exact match on the
 * trigger content beside it needs no list at all, and is the half that actually
 * caught DOR-1659.
 *
 * `env` is the one entry a model could plausibly type on its own, so in LIVE
 * mode it is the one that could fail on an honest answer. It stays because it
 * names a block DorkOS really does inject and dropping it would trade real
 * coverage for a hypothetical, and because the failure is self-describing: the
 * assertion message names the tag, so an answer that genuinely said `<env>`
 * reads as exactly that rather than as a mystery. Narrow the PROMPT before
 * narrowing this list.
 */
export const INJECTED_CONTEXT_TAGS = [
  'gen_ui',
  'agent_identity',
  'agent_persona',
  'agent_safety_boundaries',
  'agent_memory',
  'session_model',
  'working_rules',
  'dorkos_context',
  'user_profile',
  'env',
  'room_tools',
  'room_context',
  'doc_events',
  'relay_context',
  'git_status',
  'ui_state',
  'staged_context',
  'seed_context',
  'approval_verdict',
  'dork-kickoff',
];
