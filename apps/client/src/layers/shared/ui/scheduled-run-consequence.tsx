import { MoreDetails } from './more-details';
import {
  SCHEDULED_RUN_CONSENT_CONSEQUENCE,
  SCHEDULED_RUN_CONSENT_CONTRAST,
} from './consent-ritual-copy';

/**
 * What a scheduled run gives up at a stop that never asks, for the
 * `consequence` slot of `UnattendedAutonomyDialog`.
 *
 * The one fact a person must read stays visible: nobody is asked and nothing is
 * recorded. The contrast with a stop that asks waits behind "More details", so
 * each block stays short (the `writing-app-copy` overflow ladder, rung 3).
 */
export function ScheduledRunConsequence() {
  return (
    <>
      <p>{SCHEDULED_RUN_CONSENT_CONSEQUENCE}</p>
      <MoreDetails>
        {SCHEDULED_RUN_CONSENT_CONTRAST.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </MoreDetails>
    </>
  );
}
