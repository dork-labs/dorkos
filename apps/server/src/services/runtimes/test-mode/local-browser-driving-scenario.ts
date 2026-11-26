/** Real local-page tools from a scripted turn, inert unless selected on a test-mode server. */
import { z } from 'zod';
import { LocalBrowserObservationSchema } from '@dorkos/shared/local-browser';
import type { LocalBrowserService } from '../../session/local-browser/service.js';
import type { ScenarioFn } from './scenario-store.js';
import { worldOf } from './scenario-world.js';

let currentBrowser: () => LocalBrowserService | undefined = () => undefined;

/** Supply the boot-owned service to the test runtime, never a second connection or registry owner. */
export function configureLocalBrowserDriving(read: () => LocalBrowserService | undefined): void {
  currentBrowser = read;
}

/** Invoke the production capability boundary on the same page the human opened in Browser. */
export const localBrowserDrivingScenario: ScenarioFn = async function* (_content, ctx, opts) {
  const browser = currentBrowser();
  if (!browser) throw new Error('Local browser fixture requires the boot-owned browser service');
  const world = worldOf(ctx);
  const invoke = world.localBrowserTools(browser);
  const context = { sessionId: ctx.sessionId, ...(opts?.cwd ? { cwd: opts.cwd } : {}) };
  let result: string;
  try {
    const observation = LocalBrowserObservationSchema.parse(
      await invoke('local_browser.observe', {}, context)
    );
    if (_content === 'verify stale key focus' || _content === 'verify same key focus') {
      yield { type: 'text_delta', data: { text: 'local-browser: key-focus observed; ' } };
      await ctx.awaitStep();
      let outcome = 'pressed';
      try {
        await invoke(
          'local_browser.act',
          { action: { kind: 'press', key: 'Enter', revision: observation.revision } },
          context
        );
      } catch (error) {
        const refusal = world.refusalOf(error);
        if (!refusal) throw error;
        outcome = z.object({ code: z.string() }).parse(refusal.payload).code;
      }
      // A second observation is deliberately AFTER the old action; observing first would
      // invalidate its revision and make the focus refusal vacuous.
      const after = LocalBrowserObservationSchema.parse(
        await invoke('local_browser.observe', {}, context)
      );
      if (after.snapshot !== observation.snapshot)
        throw new Error('Key-focus fixture changed its accessibility snapshot');
      result = 'local-browser: ' + outcome + '; unchanged-snapshot=true';
    } else {
      await invoke(
        'local_browser.act',
        {
          action: {
            kind: 'fill',
            role: 'textbox',
            name: 'Name',
            text: 'Scripted local input',
            revision: observation.revision,
          },
        },
        context
      );
      const fresh = LocalBrowserObservationSchema.parse(
        await invoke('local_browser.observe', {}, context)
      );
      await invoke(
        'local_browser.act',
        {
          action: {
            kind: 'click',
            role: 'button',
            name: 'Save',
            revision: fresh.revision,
          },
        },
        context
      );
      const image = world.imageOf(await invoke('local_browser.screenshot', {}, context));
      if (!image || image.image.mimeType !== 'image/png' || !image.image.data)
        throw new Error('The live-page screenshot did not return PNG pixels');
      result = 'local-browser: saved; screenshot=image/png';
    }
  } catch (error) {
    const refusal = world.refusalOf(error);
    if (!refusal) throw error;
    result = `local-browser: ${z.object({ code: z.string() }).parse(refusal.payload).code}`;
  }
  yield { type: 'text_delta', data: { text: result } };
  yield { type: 'done', data: { sessionId: ctx.sessionId } };
};
