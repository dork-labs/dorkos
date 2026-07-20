/**
 * First light (M4): the calm arrival state a newborn agent's session shows in
 * the brief window between its opening turn firing and the first greetable
 * content landing. The agent's face, its name, and the quiet typing dots —
 * honest, because the turn is genuinely in flight. It stands in for the generic
 * "Start a conversation" empty state for that one moment; the instant real
 * content arrives the normal message list takes over and first light is gone.
 *
 * Known edge: if the opening turn's trigger is accepted but the turn is never
 * observed streaming or producing content, first light persists (the composer
 * stays usable throughout) — the mid-stream failure detector in
 * `use-auto-kickoff` only flips to the honest failure line once it has seen the
 * turn go live, and a bounded timeout was deliberately left out to keep that
 * just-hardened (#370) detector simple.
 *
 * @module features/chat/ui/FirstLight
 */
import { motion, useReducedMotion } from 'motion/react';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import type { AgentBirthRecord } from '@/layers/shared/model';
import { TypingDots } from './primitives';

/**
 * The first-light waking state for a newborn session.
 *
 * @param props.record - The session's birth record (name + visual identity).
 */
export function FirstLight({ record }: { record: AgentBirthRecord }) {
  const reducedMotion = useReducedMotion();
  const { color, emoji } = resolveAgentVisual({
    id: record.agentId,
    icon: record.icon,
    color: record.color,
  });
  // displayName always resolves to the slug at registration, so this fallback is
  // a belt-and-braces guard for a record that somehow arrived without a name.
  const name = record.displayName.trim() || 'Your agent';

  return (
    <div className="flex flex-col items-center gap-5 text-center" data-testid="first-light">
      <motion.div
        animate={reducedMotion ? undefined : { scale: [1, 1.05, 1], opacity: [0.9, 1, 0.9] }}
        transition={
          reducedMotion ? undefined : { duration: 3, repeat: Infinity, ease: 'easeInOut' }
        }
      >
        <AgentAvatar color={color} emoji={emoji} size="lg" />
      </motion.div>
      <div className="flex flex-col items-center gap-3">
        <p className="text-muted-foreground text-base" aria-live="polite">
          {name} is waking up…
        </p>
        <TypingDots />
      </div>
    </div>
  );
}
