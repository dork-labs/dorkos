/**
 * What a cancelled "Confirm it's you" looks like outside the cards
 * (DOR-4909): the Mac app's sheet while the shell's own window asks, and the
 * calm toast a change shows once the sheet closed without confirming. Both
 * are the real components, opened by a button, with a made-up held action.
 *
 * @module dev/showcases/StepUpCancelShowcases
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ActionStepUpHost } from '@/layers/features/auth';
import {
  STEP_UP_NOT_CONFIRMED_MESSAGE,
  finishActionStepUp,
  requestActionStepUp,
} from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** A made-up held action, shaped like the server's ids. */
const SAMPLE_HELD_ACTION = '01JSAMPLEHE1DACT10N0000000';

/** The Mac app's sheet and the shared toast after a cancelled "Confirm it's you". */
export function StepUpCancelShowcases() {
  const [macSheet, setMacSheet] = useState(false);

  useEffect(() => {
    if (!macSheet) return;
    // The shell's window never answers here, so the sheet stays open until
    // the page is left, as it would while the person types.
    const had = window.electronAPI;
    window.electronAPI = {
      ...had,
      confirmStepUp: () => new Promise(() => undefined),
    } as NonNullable<Window['electronAPI']>;
    void requestActionStepUp(SAMPLE_HELD_ACTION);
    return () => {
      finishActionStepUp(SAMPLE_HELD_ACTION, { kind: 'not-confirmed' });
      window.electronAPI = had;
    };
  }, [macSheet]);

  return (
    <PlaygroundSection
      title="Step-up not confirmed"
      description="The Mac app's sheet while its own window asks, and the calm toast after a cancel."
    >
      <ShowcaseLabel>The Mac app sheet while the “Confirm it’s you” window is open</ShowcaseLabel>
      <ShowcaseDemo>
        <Button type="button" variant="outline" size="sm" onClick={() => setMacSheet(true)}>
          Open the Mac app sheet
        </Button>
        {macSheet && <ActionStepUpHost />}
      </ShowcaseDemo>

      <ShowcaseLabel>The toast after a change was not confirmed</ShowcaseLabel>
      <ShowcaseDemo>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => toast(STEP_UP_NOT_CONFIRMED_MESSAGE)}
        >
          Show the toast
        </Button>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
