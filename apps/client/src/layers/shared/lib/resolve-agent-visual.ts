import { seedAgentFace } from '@dorkos/shared/agent-face';

/** Minimal shape needed to resolve agent visual identity. */
export interface AgentVisualSource {
  id: string;
  color?: string | null;
  icon?: string | null;
}

/** Resolved visual identity for an agent. */
export interface AgentVisual {
  /** CSS color string (HSL or user override) */
  color: string;
  /** Single emoji character */
  emoji: string;
}

/**
 * Resolve agent visual identity from overrides or the deterministic seed.
 *
 * Priority: `agent.color`/`agent.icon` -> the face DorkOS would seed for this
 * id. It runs `seedAgentFace` — the same function the SERVER runs at creation
 * (DOR-949) — rather than a second hash of its own, so "auto" here and "seeded"
 * there are the same face. They used to differ: this resolver hashed a
 * continuous HSL color while the server wrote a palette hex, so clearing an
 * override handed the agent a color it had never worn.
 *
 * Pure function — no React dependency. Use directly in non-hook contexts
 * (topology builders, command palette items, pickers, etc.).
 *
 * @param agent - The agent's id and whatever face it has stored.
 */
export function resolveAgentVisual(agent: AgentVisualSource): AgentVisual {
  // Nullish, NOT truthiness — the opposite of the rule `seedAgentFace` applies
  // to its own `chosen` argument, and deliberately so. At creation an empty
  // string is not a choice and must not be persisted as a face. Here it is a
  // caller saying "draw no glyph": onboarding renders an explicitly empty icon
  // while it is still finding out which agent DorkBot is, and seeding over that
  // would put an invented face — hashed from the SLUG, not the agent — on the
  // largest disc on screen (DOR-1122). Absent means "nobody has said"; empty
  // means "somebody said none".
  const seeded = seedAgentFace(agent.id);
  return {
    color: agent.color ?? seeded.color,
    emoji: agent.icon ?? seeded.icon,
  };
}
