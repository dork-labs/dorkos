import { create } from 'zustand';

/**
 * A newborn agent's birth record — everything the first session needs to (a)
 * trigger the agent's opening turn once and (b) show the quiet birth-certificate
 * line ("★ {name} · born {date} · lives in {path} · runs on {runtime}"). Keyed
 * by the session id the agent is born into.
 *
 * This store is deliberately EPHEMERAL (in-memory, not persisted): the birth is
 * a moment. It carries the ceremony through the create → navigate → first-turn
 * flow (including the client-id → SDK-id rekey) within one page session. The
 * durable payoff — the agent's greeting — lives in the transcript; a reload
 * shows that, not the certificate. Other sessions never carry a record, so the
 * certificate can never reappear on the agent's later conversations.
 */
export interface AgentBirthRecord {
  /** Kebab-case agent slug. */
  name: string;
  /** Human display name for the certificate. */
  displayName: string;
  /**
   * The agent's ULID — the seed for its deterministic visual identity, the same
   * id the rest of the app hashes for an agent's color and face. Carried so the
   * first-light avatar matches the agent everywhere else it appears on screen.
   */
  agentId: string;
  /** Emoji face override, when the agent has one (the create-flow face pick). */
  icon?: string;
  /** Color override, when the agent has one. */
  color?: string;
  /** ISO creation timestamp (the agent manifest's `registeredAt`). */
  bornAt: string;
  /** Absolute directory the agent lives in. */
  path: string;
  /** The runtime the agent runs on (e.g. `claude-code`). */
  runtime: string;
  /** The fenced kickoff message to trigger the agent's first turn with. */
  kickoffMessage: string;
  /**
   * What kind of opening turn this record fires (ADR 260722-111316). Defaults to
   * `'kickoff'` (undefined reads as `'kickoff'`): the agent-says-hello-first path,
   * which suppresses the user bubble. `'first-message'` is the opposite — the
   * onboarding dissolve carries the user's own typed words into a fresh session,
   * so `useAutoKickoff` submits it through the normal path and the user's bubble
   * renders as theirs. Optional so every existing kickoff call site is unchanged.
   */
  kind?: 'kickoff' | 'first-message';
  /** Set once the first turn has been triggered — the fire-once latch. */
  fired: boolean;
  /**
   * Set when the agent never got to say hello — either the kickoff trigger
   * failed and its one silent retry was also spent, OR the trigger was accepted
   * but the turn died mid-stream (started, then ended or errored before any
   * assistant text). Drives an honest empty-session line ("{name} couldn't say
   * hello just now — send a message to get started.") instead of leaving the
   * person staring at a blank session.
   */
  greetingFailed?: boolean;
}

interface AgentBirthState {
  /** Birth records keyed by session id. */
  records: Record<string, AgentBirthRecord>;
  /** Record a birth for a freshly created agent's session. */
  register: (sessionId: string, record: Omit<AgentBirthRecord, 'fired'>) => void;
  /** Latch a record as fired so the kickoff never re-triggers. */
  markFired: (sessionId: string) => void;
  /**
   * Un-latch a record after a FAILED trigger (the POST rejected, so no turn
   * started) so `useAutoKickoff` may retry once. Never called for a trigger
   * that was accepted.
   */
  resetFired: (sessionId: string) => void;
  /**
   * Mark that the kickoff could not be delivered (the trigger failed and its
   * one retry was spent). Surfaces the honest greeting-failed line. No-op when
   * no record exists.
   */
  markGreetingFailed: (sessionId: string) => void;
  /**
   * Follow the create-on-first-message rekey: move a record from the throwaway
   * client id to the SDK-canonical id so the certificate stays put and the
   * fired latch is preserved. No-op when no record exists at `oldId`.
   */
  migrate: (oldId: string, newId: string) => void;
  /**
   * Claim an UNFIRED birth registered for this agent directory but never
   * visited under its original session id — the create path that records a
   * birth without opening a session (e.g. onboarding advances instead of
   * navigating). The first fresh session opened in that directory re-keys the
   * record to itself, so the hello + certificate land on the agent's real
   * first session. Synchronous re-key means only one session can ever claim
   * a record. Returns the claimed record, or null when none matches.
   */
  claimByPath: (path: string, sessionId: string) => AgentBirthRecord | null;
}

/** Ephemeral store of newborn-agent birth records (M4). */
export const useAgentBirthStore = create<AgentBirthState>((set, get) => ({
  records: {},
  register: (sessionId, record) =>
    set((s) => ({ records: { ...s.records, [sessionId]: { ...record, fired: false } } })),
  markFired: (sessionId) =>
    set((s) => {
      const existing = s.records[sessionId];
      if (!existing || existing.fired) return s;
      return { records: { ...s.records, [sessionId]: { ...existing, fired: true } } };
    }),
  resetFired: (sessionId) =>
    set((s) => {
      const existing = s.records[sessionId];
      if (!existing || !existing.fired) return s;
      return { records: { ...s.records, [sessionId]: { ...existing, fired: false } } };
    }),
  markGreetingFailed: (sessionId) =>
    set((s) => {
      const existing = s.records[sessionId];
      if (!existing || existing.greetingFailed) return s;
      return { records: { ...s.records, [sessionId]: { ...existing, greetingFailed: true } } };
    }),
  migrate: (oldId, newId) =>
    set((s) => {
      const record = s.records[oldId];
      if (!record || oldId === newId) return s;
      const next = { ...s.records };
      delete next[oldId];
      next[newId] = record;
      return { records: next };
    }),
  claimByPath: (path, sessionId) => {
    const entry = Object.entries(get().records).find(([, rec]) => rec.path === path && !rec.fired);
    if (!entry) return null;
    const [key, record] = entry;
    if (key !== sessionId) get().migrate(key, sessionId);
    return record;
  },
}));

/**
 * Subscribe to the birth record for one session (or `null`). A stable selector,
 * so a session with no record never re-renders its consumer on unrelated writes.
 *
 * @param sessionId - The active session id, or null.
 */
export function useAgentBirthRecord(sessionId: string | null): AgentBirthRecord | null {
  return useAgentBirthStore((s) => (sessionId ? (s.records[sessionId] ?? null) : null));
}
