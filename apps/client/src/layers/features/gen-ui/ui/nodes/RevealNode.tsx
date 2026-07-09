import { useState } from 'react';
import { motion } from 'motion/react';
import type { TargetAndTransition, Transition } from 'motion/react';
import {
  Coins,
  Dice1,
  Dice2,
  Dice3,
  Dice4,
  Dice5,
  Dice6,
  Dices,
  type LucideIcon,
} from 'lucide-react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion, WIDGET_SPRING } from '../../lib/widget-motion';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type RevealKind = NodeOf<'reveal'>['kind'];

/** How long the suspense animation plays before the object settles and the result appears. */
const REVEAL_SUSPENSE_DURATION = 1.2;

const OBJECT_SHAPE_CLASS: Record<RevealKind, string> = {
  coin: 'rounded-full bg-status-warning-bg border-status-warning-border text-status-warning-fg',
  d6: 'rounded-xl bg-muted border-border text-foreground',
  d20: 'rounded-xl bg-muted border-border text-foreground',
  '8ball': 'rounded-full bg-foreground border-foreground text-background',
};

const DICE_ICONS: LucideIcon[] = [Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];

/** Per-kind suspense motion: the "shuffle" that plays before the reveal settles. */
function suspenseAnimation(kind: RevealKind): {
  animate: TargetAndTransition;
  transition: Transition;
} {
  const transition: Transition = { duration: REVEAL_SUSPENSE_DURATION, ease: 'easeOut' };
  switch (kind) {
    case 'coin':
      return { animate: { rotateY: [0, 360, 720, 1080] }, transition };
    case 'd6':
    case 'd20':
      return { animate: { rotate: [0, -15, 15, -10, 10, 0], x: [0, -2, 2, -2, 2, 0] }, transition };
    case '8ball':
      return { animate: { x: [0, -6, 6, -4, 4, -2, 2, 0] }, transition };
  }
}

/**
 * The object's glyph. `d6` shows a dice-pip icon when the result is a 1-6
 * digit (falling back to a generic dice icon); `d20` draws a simple hexagonal
 * polygon instead — a die that large is never shown by pips.
 */
function ObjectGlyph({ kind, result }: { kind: RevealKind; result: string }) {
  switch (kind) {
    case 'coin':
      return <Coins className="size-7" aria-hidden />;
    case '8ball':
      return <span aria-hidden>8</span>;
    case 'd20':
      return (
        <svg viewBox="0 0 24 24" className="size-7" aria-hidden>
          <polygon
            points="12,2 21,8 21,16 12,22 3,16 3,8"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'd6': {
      const pip = Number(result);
      const DiceIcon = Number.isInteger(pip) && pip >= 1 && pip <= 6 ? DICE_ICONS[pip - 1] : Dices;
      return <DiceIcon className="size-7" aria-hidden />;
    }
  }
}

/**
 * `reveal` node — an animated coin flip, dice roll, or magic-8-ball reveal. The
 * agent supplies the `result`; the client just performs the suspense animation
 * and reveal. Clicking the object replays the animation from local state, no
 * new result — that only the agent can supply.
 */
export function RevealNode({ node }: { node: NodeOf<'reveal'> }) {
  const motionOn = useWidgetMotion();
  const [replayKey, setReplayKey] = useState(0);
  const [settled, setSettled] = useState(!motionOn);
  const { animate, transition } = suspenseAnimation(node.kind);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`Replay the ${node.kind} reveal`}
        onClick={() => {
          if (!motionOn) return;
          setSettled(false);
          setReplayKey((k) => k + 1);
        }}
        className={cn(
          'focus-ring flex size-16 shrink-0 items-center justify-center border-2 text-lg font-bold',
          OBJECT_SHAPE_CLASS[node.kind]
        )}
      >
        <motion.span
          key={replayKey}
          className="flex items-center justify-center"
          initial={motionOn ? { rotate: 0, x: 0, rotateY: 0 } : false}
          animate={motionOn ? animate : false}
          transition={motionOn ? transition : undefined}
          onAnimationComplete={() => setSettled(true)}
        >
          <ObjectGlyph kind={node.kind} result={node.result} />
        </motion.span>
      </button>
      <div className="flex flex-col gap-0.5">
        {node.label && <span className="text-muted-foreground text-xs">{node.label}</span>}
        <motion.span
          aria-live="polite"
          className="text-foreground text-lg font-semibold tabular-nums"
          initial={motionOn ? { opacity: 0, scale: 1.3 } : false}
          animate={settled ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 1.3 }}
          transition={WIDGET_SPRING}
        >
          {settled ? node.result : ''}
        </motion.span>
      </div>
    </div>
  );
}
