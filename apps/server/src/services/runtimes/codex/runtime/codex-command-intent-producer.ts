import type { StreamEvent } from '@dorkos/shared/types';
import type { CommandIntentOpts } from '@dorkos/shared/agent-runtime';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import { nothingToSummarize } from '../transport/app-server-transport.js';
import {
  catalogNameFor,
  decideCreditsLaunchModel,
  type CreditsModelDecision,
} from '../../../core/cloud/credits-models.js';
import {
  creditsRefusalEvent,
  asCreditsStopped,
  type CreditsLaunch,
} from '../../../core/cloud/credits-protocols.js';
import { createCodexEventContext } from '../event-mapper.js';
import type { OriginalCodexOwnedMessageView } from './codex-owned-message-context.js';

/** Each factory owns unrelated command keys; the runtime alone keeps its actual original registrar. */
export function createIsolatedCodexCommandIntentProducer() {
  const views = new WeakMap<object, OriginalCodexOwnedMessageView>();
  const get = WeakMap.prototype.get;
  const set = WeakMap.prototype.set;
  const apply = Reflect.apply;
  function actual(owner: object): OriginalCodexOwnedMessageView {
    const view = apply(get, views, [owner]) as OriginalCodexOwnedMessageView | undefined;
    if (!view) throw new Error('Unknown original Codex command intent producer.');
    return view;
  }
  async function* executeOriginalCommandIntent(
    owner: object,
    sessionId: string,
    _intent: RuntimeCommandIntentId,
    opts?: CommandIntentOpts
  ): AsyncGenerator<StreamEvent> {
    const facet = actual(owner);
    const compact = facet.transport.compact?.bind(facet.transport);
    if (!compact) {
      throw new Error('executeCommandIntent(compact) is not supported by codex on exec');
    }
    await facet.seedFromDurable(sessionId);
    const settings = await facet.resolveTurnSettings(sessionId, opts);
    const binding = facet.threadMap.get(sessionId);
    const boundThreadId = binding?.threadId;
    // No thread, no conversation: said before anything about who would pay.
    if (boundThreadId === undefined) {
      yield* nothingToSummarize(sessionId);
      return;
    }
    const cwd = opts?.cwd ?? facet.registry.get(sessionId)?.cwd ?? binding?.cwd ?? facet.defaultCwd;
    let credits: CreditsLaunch | null;
    let creditsSwap: CreditsModelDecision['swap'];
    try {
      credits = await facet.creditsLaunchFor(boundThreadId);
      // The same model decision a credits turn makes (DOR-2636): a list that
      // names no model Codex can run refuses the summary too. A swap it makes
      // is said and saved here, but takes effect from the next turn:
      // `thread/compact/start` takes no model, so the summary runs on the
      // model the thread already has.
      if (credits) {
        creditsSwap = (
          await decideCreditsLaunchModel({
            capabilities: facet.getCapabilities(),
            runtimeLabel: 'Codex',
            sessionId,
            model: settings.model,
            nameOf: async () =>
              settings.model === undefined
                ? undefined
                : catalogNameFor(facet.runtime, settings.model),
            remember: async (model) => {
              await facet.updateSession(sessionId, { model });
            },
          })
        ).swap;
      }
    } catch (err) {
      const refusal = creditsRefusalEvent(err);
      if (!refusal) throw err;
      yield refusal;
      yield { type: 'done', data: { sessionId } };
      return;
    }
    if (creditsSwap?.notice) yield creditsSwap.notice;
    await creditsSwap?.commit();
    const controller = new AbortController();
    facet.activeTurns.set(sessionId, controller);
    if (credits) facet.creditsTurns.add(controller);
    try {
      const events = compact({
        binary: await facet.resolveTurnBinary(),
        sessionId,
        boundThreadId,
        cwd,
        settings,
        launch: credits ? { home: 'credits', credits } : { home: 'person' },
        signal: controller.signal,
        events: createCodexEventContext(sessionId),
        onThreadBound: (threadId, replaces) => {
          if (replaces !== undefined)
            facet.threadMap.replaceThreadId(sessionId, replaces, threadId);
        },
      });
      let summarized = false;
      for await (const event of events) {
        if (event.type === 'compact_boundary') summarized = true;
        yield credits ? asCreditsStopped(event, 'Codex') : event;
      }
      // The summary may have dropped the identity this thread was told.
      if (summarized) facet.contextGate.forget(sessionId);
    } finally {
      facet.creditsTurns.delete(controller);
      if (facet.activeTurns.get(sessionId) === controller) facet.activeTurns.delete(sessionId);
    }
  }
  return Object.freeze({
    register(owner: object, view: OriginalCodexOwnedMessageView): void {
      apply(set, views, [owner, view]);
    },
    executeOriginalCommandIntent,
  });
}
