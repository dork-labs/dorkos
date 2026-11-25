/**
 * The capability conformance suite's sample inputs for a chat's reads: its
 * change review (`diff.*`), its runs (`runs.chat_runs`) and the work graph's
 * reads (`work-graph.*`). Each is parseable, so the handler answers with its
 * own structured refusal rather than a ZodError, which is what "wired" means
 * there (`./capability-conformance.test.ts`).
 *
 * @module services/core/capabilities/__tests__/chat-read-sample-inputs
 */

/** Sample inputs, by capability id. */
export const CHAT_READ_SAMPLE_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  // Paths outside the boundary, so each answers its own path refusal.
  'diff.baseline': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
  'diff.advance_baseline': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
  'diff.pending': { cwd: '/conformance', sessionId: 'conformance-chat' },
  'diff.revert': { cwd: '/conformance', path: 'a.ts', sessionId: 'conformance-chat' },
  // A chat id is required, so `{}` would be a ZodError. With no run record
  // wired here, the handler answers its own `NOT_READY` refusal.
  'runs.chat_runs': { id: '00000000-0000-4000-8000-0000000c0a55' },
  // An agent or chat is required. No agent is registered and no work graph is
  // installed here, so each answers its own `WORK_GRAPH_AGENT_NOT_FOUND` or `NOT_READY`.
  'work-graph.agent_chats': { agentId: '01JCONFORMANCEAGENT0000000' },
  'work-graph.agent_work': { agentId: '01JCONFORMANCEAGENT0000000' },
  'work-graph.chat_tree': { chatId: 'conformance-chat' },
  'work-graph.chat_work': { chatId: 'conformance-chat' },
};
