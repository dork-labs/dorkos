/**
 * A server-half fixture that uses every `ctx.inbox` member the way a real
 * extension would (spec `flow-multiproject` §10.3): it raises, updates and
 * resolves a decision, answers actions, makes an offer, asks a question with
 * a near deadline, and records a history-only decision.
 *
 * `register` has the `ServerExtensionRegister` shape, so the conformance test
 * drives it through the real `createDataProviderContext`.
 */
import type { Router } from 'express';
import type { DataProviderContext } from '@dorkos/extension-api/server';

/** What the fixture was told, for the test to read. */
export const heard: Array<{
  extension: string;
  action: string;
  decidedBy: string;
  choiceId: string | null;
}> = [];

/**
 * Register the fixture: an action handler, and a person-only route.
 *
 * @param router - The extension's router.
 * @param ctx - Its context.
 */
export function register(router: Router, ctx: DataProviderContext): () => void {
  const stop = ctx.inbox.onAction(async (event) => {
    heard.push({
      extension: ctx.extensionId,
      action: event.action,
      decidedBy: event.decidedBy,
      choiceId: event.choiceId,
    });
    if (event.key === 'slow') return new Promise(() => {});
    if (event.action === 'offer') return { resolve: 'approved', message: 'Done.' };
    if (event.action === 'word') return { keepOpen: true, message: 'Looking into it.' };
    return {
      resolve:
        event.action === 'reject'
          ? 'rejected'
          : event.action === 'choice'
            ? 'answered'
            : 'approved',
      offer: { text: 'Next time, do this on its own?', offerId: 'auto' },
    };
  });
  router.put('/settings', ctx.requirePerson, (_req, res) => {
    res.json({ ok: true });
  });
  return stop;
}

/**
 * Raise the fixture's decisions.
 *
 * @param ctx - The extension's context.
 * @param deadline - When the question's deadline falls.
 */
export async function raiseAll(ctx: DataProviderContext, deadline: string): Promise<void> {
  const shipActions = {
    kind: 'yes-no' as const,
    approveLabel: 'Ship it',
    rejectLabel: 'Send it back',
  };
  await ctx.inbox.raise({
    key: 'ship',
    title: 'Ship it?',
    why: 'It is built and the reviewer agent found nothing.',
    actions: shipActions,
  });
  await ctx.inbox.raise({
    key: 'ship',
    title: 'Ship it now?',
    why: 'It is built and the reviewer agent found nothing.',
    actions: shipActions,
  });
  await ctx.inbox.raise({
    key: 'question',
    title: 'Keep the old API?',
    why: 'Removing it breaks two scripts.',
    actions: {
      kind: 'choice',
      choices: [
        { id: 'keep', label: 'Keep it' },
        { id: 'remove', label: 'Remove it' },
      ],
      defaultChoice: 'keep',
      decideBy: deadline,
    },
  });
  await ctx.inbox.raise({
    key: 'linear-down',
    title: 'Sign in to Linear again',
    why: 'Nothing new starts until you do.',
    actions: { kind: 'word', label: 'Answer', input: { placeholder: 'Why?', maxLength: 200 } },
  });
  await ctx.inbox.record({
    key: 'sorted',
    title: 'Sorted 12 ideas',
    why: 'They were waiting a day.',
    outcome: 'answered',
    by: { kind: 'rule', label: "your 'Just do it' setting" },
  });
}
