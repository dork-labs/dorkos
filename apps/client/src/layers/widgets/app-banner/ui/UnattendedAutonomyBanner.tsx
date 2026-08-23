import { Fragment, type ReactNode } from 'react';
import { Zap } from 'lucide-react';
import type {
  UnattendedAutonomyDriver,
  UnattendedDriverKind,
} from '@dorkos/shared/permission-semantics';

import { Banner, Button } from '@/layers/shared/ui';
import { useSafeNavigate } from '@/layers/shared/model';

/** How many drivers are named before the rest become a count. */
const NAMED_LIMIT = 2;

/** The word a person uses for each kind of driver, matching the surface it lives on. */
const KIND_NOUN: Record<UnattendedDriverKind, string> = {
  binding: 'integration',
  task: 'task',
};

/**
 * Join phrases the way a person says them aloud: "A", "A and B", "A, B and C".
 * No Oxford comma, matching the rest of the product's voice.
 */
function joinPhrases(phrases: ReactNode[]): ReactNode {
  return phrases.map((phrase, index) => (
    <Fragment key={index}>
      {index > 0 && (index === phrases.length - 1 ? ' and ' : ', ')}
      {phrase}
    </Fragment>
  ));
}

export interface UnattendedAutonomyBannerProps {
  /** Every live driver currently running without asking. Empty renders nothing. */
  drivers: UnattendedAutonomyDriver[];
}

/**
 * The standing note for full power nobody is watching — an agent running behind
 * a relay integration or a scheduled task, with no one in front of it.
 *
 * ## Why this one survived when the session banner did not
 *
 * The Trust Dial retired the app-wide bypass banner for attended sessions: it
 * repeated what the status strip already said about a session the person was
 * looking at, and two voices for one fact teach people to read neither (spec
 * `trust-dial`, decision 3A). The unattended half is the opposite case. Nobody
 * is looking at anything — there is no strip, no transcript, no approval card —
 * so this is not a second voice, it is the only one.
 *
 * ## Why it is information rather than a warning
 *
 * Running at full power is the setting this product is for, and after the
 * defaults flip it is what most installs look like (spec `full-power-defaults`,
 * D8). A standing amber row over a normal, chosen state is an alarm that is
 * always on, which is the fastest way to teach somebody to stop reading the
 * row — and to stop reading the next one, which might be an actual problem. So
 * the tone is flat: this is what is running, here is where to change it.
 *
 * ## Why it names things instead of counting them
 *
 * "2 agents are running at full power" is a number; "the Deploys integration and
 * the Nightly cleanup task" is something a person can act on. Naming is also
 * what keeps the row honest as it truncates: past two, the remainder becomes a
 * count rather than a wall of text, and the server's stable ordering means the
 * two that are named do not shuffle between reads.
 *
 * ## Why it cannot be dismissed
 *
 * The condition is standing, not an announcement — true until somebody changes a
 * setting, and gone the moment they do. A dismiss button would let the one
 * signal with no other home be hidden while it is still true. What keeps that
 * from nagging is everything else about it: one row, one line, no modal, no
 * repetition, and no ceremony when the last driver is dialled back.
 *
 * @param drivers - Every live driver currently running at full power.
 */
export function UnattendedAutonomyBanner({ drivers }: UnattendedAutonomyBannerProps) {
  // `null` in the Obsidian embed, which has no router — and no bindings or tasks
  // either, so this component never renders there. The actions simply drop out
  // rather than offering a control that would throw on click.
  const navigate = useSafeNavigate();
  if (drivers.length === 0) return null;

  const named = drivers.slice(0, NAMED_LIMIT);
  const remaining = drivers.length - named.length;

  // Lower-case "the" throughout: the list is introduced by a colon, so no phrase
  // starts a sentence any more.
  const phrases: ReactNode[] = named.map((driver) => (
    <>
      the <span className="font-medium">{driver.name}</span> {KIND_NOUN[driver.kind]}
    </>
  ));
  if (remaining > 0) phrases.push(<>{remaining} more</>);

  const kinds = new Set(drivers.map((driver) => driver.kind));

  return (
    <Banner
      variant="info"
      icon={Zap}
      actions={
        navigate ? (
          <>
            {kinds.has('binding') && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate({
                    to: '.',
                    search: (prev: Record<string, unknown>) => ({ ...prev, relay: 'open' }),
                  })
                }
              >
                Integrations
              </Button>
            )}
            {kinds.has('task') && (
              <Button variant="outline" size="sm" onClick={() => navigate({ to: '/tasks' })}>
                Tasks
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      Running unattended at full power: {joinPhrases(phrases)}.
    </Banner>
  );
}
