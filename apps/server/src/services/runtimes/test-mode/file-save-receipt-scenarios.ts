/** Credential-free browser fixture that invokes the real production session FILE opener. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioFn } from './scenario-store.js';
import { controlUi } from '../../session/browser-seat/ui-control.js';

/** Only TestModeRuntime loads this registry; no model, synthetic Doc row or saved event is involved. */
export function fileSaveReceiptScenarios(): Record<string, ScenarioFn> {
  return {
    'ordinary-file-save-receipt': async function* (_content, ctx, opts) {
      if (!opts?.cwd)
        throw new Error('The receipt fixture requires its actual seeded session directory.');
      const cwd = await fs.realpath(opts.cwd);
      const sourcePath = join(cwd, 'ordinary-file-save-receipt.txt');
      await fs.writeFile(sourcePath, 'Original private browser fixture bytes.', {
        flag: 'wx',
        mode: 0o600,
      });
      const result = await controlUi(
        {
          action: 'open_canvas',
          content: { type: 'file', title: 'Ordinary save receipt', sourcePath, language: 'text' },
        },
        { sessionId: ctx.sessionId, cwd }
      );
      if (result.success !== true || typeof result.documentId !== 'string')
        throw new Error('Production file opener refused the receipt fixture.');
      yield {
        type: 'text_delta',
        data: { text: 'Opened the private ordinary file-save fixture.' },
      };
      yield { type: 'done', data: { sessionId: ctx.sessionId } };
    },
  };
}
