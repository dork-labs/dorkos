/** Credential-free browser fixture: one inline canvas document for the route-controls spec. */
import type { ScenarioFn } from './scenario-store.js';
import { controlUi } from '../../session/browser-seat/ui-control.js';

/** Only TestModeRuntime loads this registry; it opens a document and declares nothing. */
export function docRouteScenarios(): Record<string, ScenarioFn> {
  return {
    'doc-routes-checklist': async function* (_content, ctx, opts) {
      const result = await controlUi(
        {
          action: 'open_canvas',
          content: {
            type: 'markdown',
            title: 'Launch checklist',
            content: '# Launch checklist\n\n- [ ] Write the release notes\n- [ ] Tell the team',
          },
        },
        { sessionId: ctx.sessionId, ...(opts?.cwd ? { cwd: opts.cwd } : {}) }
      );
      if (result.success !== true || typeof result.documentId !== 'string')
        throw new Error('The canvas opener refused the route-controls fixture.');
      yield { type: 'text_delta', data: { text: 'Opened the launch checklist.' } };
      yield { type: 'done', data: { sessionId: ctx.sessionId } };
    },
  };
}
