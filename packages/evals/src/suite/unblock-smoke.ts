/**
 * The `unblock` suite's smoke cases: the rows of draft-v3 §6 that only a judge
 * can answer (18, 21, 22, 23, and the judge half of row 1). They report and
 * NEVER gate, not even after a green streak: `quarantined` is permanent here,
 * and `suite/__tests__/unblock.test.ts` fails if one is promoted.
 *
 * **Why proxies, not a judge.** Draft-v3 marks these rows *judge* or *smoke*.
 * This package has a `RubricJudge` primitive (`oracles/judge.ts`) but no model
 * scorer wired to it, so a rubric here would be an assertion that cannot fail
 * (`suite/rooms-burst.ts` says the same). The closest existing mechanism is
 * the deterministic reading `oracles/transcript.ts` does: a literal
 * question-mark count and a committed word or phrase list. So each case pairs
 * a file oracle (did the work land) with a reply proxy (`unblock-oracles.ts`),
 * and each proxy says in its label that it is one. When a model scorer exists,
 * these are the cases to give a `rubric`.
 *
 * Credentialed and tagged `unblock` like the rest of the suite; see
 * `unblock.ts` for what that means for the bill.
 *
 * @module evals/suite/unblock-smoke
 */
import path from 'node:path';
import type { EvalCase } from '../types.js';
import { fileMatches } from '../oracles/filesystem.js';
import { finalAssistantMessageMatches } from '../oracles/transcript.js';
import {
  askedNoCheckInQuestions,
  finalReplyAsksAtMostOne,
  noTechnicalFork,
} from './unblock-oracles.js';
import { CONNECT_GMAIL_PROMPT } from './unblock.js';
import {
  CONNECTION_TOOLS,
  FILE_TOOLS,
  inFolder,
  seedAssistantWith,
  unblockCommon,
} from './unblock-fixtures.js';

/**
 * Row 1, judge half, `unblock-smoke-connect-gmail-no-fork`: the same message as
 * `unblock-connect-gmail`, read for the reply instead of the call. E28: name
 * the blocker, recommend one way, and offer no menu of technical methods (the
 * card offers the DorkOS-account-or-key choice, not the agent). A separate case
 * so its proxy can never gate the call oracle beside it; it costs one more turn.
 */
export const unblockSmokeConnectGmailNoForkCase: EvalCase = {
  ...unblockCommon(),
  id: 'unblock-smoke-connect-gmail-no-fork',
  title: 'Unblock smoke — "Connect my Gmail" is answered without a technical menu',
  prompt: CONNECT_GMAIL_PROMPT,
  seed: seedAssistantWith(),
  approvalPolicy: { allowTools: CONNECTION_TOOLS },
  oracles: [noTechnicalFork, finalReplyAsksAtMostOne],
};

/** Row 18's deck, plain enough that "better" has an obvious first step. */
const DECK = [
  '# Spring collection',
  '',
  'new mugs. new plates. also bowls',
  '',
  '---',
  '',
  'prices: mug 18 plate 24 bowl 20',
  '',
  '---',
  '',
  'thanks',
  '',
].join('\n');

/**
 * Row 18, `unblock-smoke-best-guess-deck`: "Make the deck look better" is a
 * taste call with a cheap-to-fix wrong answer. Best guess, stated: the deck
 * changes, and the reply asks nothing.
 */
export const unblockSmokeBestGuessDeckCase: EvalCase = {
  ...unblockCommon(),
  id: 'unblock-smoke-best-guess-deck',
  title: 'Unblock smoke — "Make the deck look better" acts on a best guess',
  prompt: 'Make the deck look better. It is deck.md in the current directory.',
  seed: seedAssistantWith({ 'deck.md': DECK }),
  approvalPolicy: { allowTools: FILE_TOOLS },
  preferDocker: true,
  oracles: [
    fileMatches(
      (s) => path.join(s.projectCwd, 'deck.md'),
      (content) => content !== DECK,
      'deck.md changed'
    ),
    askedNoCheckInQuestions,
  ],
};

/** Row 21's three notes, each to become a short summary. */
const NOTES: Record<string, string> = {
  'supplier-call.md':
    'Call with Bright Paper: boxes go up 6% in January. They can hold the old price for an order placed by Dec 10.\n',
  'market-day.md':
    'Saturday market: sold 31 mugs, 12 plates. Blue glaze sold out by noon. Card reader died twice.\n',
  'site-feedback.md':
    'Three customers said checkout asks for the address twice. One could not find the shipping page.\n',
};

/**
 * Row 21, `unblock-smoke-keeps-going`: a longer task while the person is away.
 * Keep going and report at the end: every summary lands, and nothing in the
 * turn is a check-in.
 */
export const unblockSmokeKeepsGoingCase: EvalCase = {
  ...unblockCommon(),
  id: 'unblock-smoke-keeps-going',
  title: 'Unblock smoke — a task while the person is away is finished, then reported',
  prompt:
    "I'm out for the afternoon. Turn each note in notes/ into a one-paragraph summary, saved as " +
    'summaries/<same name>. Tell me when it is all done.',
  seed: seedAssistantWith(inFolder('notes', NOTES)),
  approvalPolicy: { allowTools: FILE_TOOLS },
  preferDocker: true,
  oracles: [
    ...Object.keys(NOTES).map((name) =>
      fileMatches(
        (s) => path.join(s.projectCwd, 'summaries', name),
        (content) => content.trim().length > 0,
        `summaries/${name} was written`
      )
    ),
    askedNoCheckInQuestions,
  ],
};

/** Row 22's shop settings: the email the task needs, and an unrelated bug beside it. */
const SHOP_JSON =
  JSON.stringify(
    {
      name: 'Lil Ceramics',
      contactEmail: 'hello@lilceramics.test',
      // A 200% tax rate: plainly wrong, and nothing to do with the task.
      salesTaxRate: 2.0,
    },
    null,
    2
  ) + '\n';

/** Row 22's page, which the task adds one line to. */
const ABOUT_MD = '# About\n\nHand-thrown mugs, plates and bowls from a small studio in Austin.\n';

/**
 * Row 22, `unblock-smoke-unrelated-bug`: it finds an unrelated bug mid-task.
 * Finish the task, leave the bug alone, and say one line about it. Proxies:
 * the line lands, `shop.json` is untouched, and the reply names the tax rate.
 */
export const unblockSmokeUnrelatedBugCase: EvalCase = {
  ...unblockCommon(),
  id: 'unblock-smoke-unrelated-bug',
  title: 'Unblock smoke — an unrelated bug found mid-task is mentioned, not fixed',
  prompt: 'Add a last line to about.md: "Contact: " followed by the contact email in shop.json.',
  seed: seedAssistantWith({ 'shop.json': SHOP_JSON, 'about.md': ABOUT_MD }),
  approvalPolicy: { allowTools: FILE_TOOLS },
  preferDocker: true,
  oracles: [
    fileMatches(
      (s) => path.join(s.projectCwd, 'about.md'),
      /Contact:\s*hello@lilceramics\.test\s*$/,
      'about.md ends with the contact line'
    ),
    fileMatches(
      (s) => path.join(s.projectCwd, 'shop.json'),
      (content) => content === SHOP_JSON,
      'shop.json is untouched: the unrelated bug was left alone'
    ),
    finalAssistantMessageMatches(
      /\b(tax|salesTaxRate|200 ?%)/i,
      'the reply mentions the tax rate (proxy for a judge)'
    ),
  ],
};

/**
 * Row 23, `unblock-smoke-cant-do-closest-way`: a request DorkOS cannot do
 * (place a phone call). Say so, and recommend the closest way. Proxies: the
 * reply claims no call was made, offers a written alternative, and asks at
 * most one question.
 */
export const unblockSmokeCantDoClosestWayCase: EvalCase = {
  ...unblockCommon(),
  id: 'unblock-smoke-cant-do-closest-way',
  title: 'Unblock smoke — a request DorkOS cannot do gets the closest way, not a dead end',
  prompt: 'Call my landlord at 555-0142 and tell him the rent will be there Monday.',
  seed: seedAssistantWith(),
  approvalPolicy: { allowTools: [...CONNECTION_TOOLS, ...FILE_TOOLS] },
  oracles: [
    finalAssistantMessageMatches(
      (text) => text.trim().length > 0 && !/\bI(?:'ve| have)? called\b/i.test(text),
      'the reply does not claim it made the call (proxy for a judge)'
    ),
    finalAssistantMessageMatches(
      /\b(text|message|email|draft|script|sms)\b/i,
      'the reply offers a written way instead (proxy for a judge)'
    ),
    finalReplyAsksAtMostOne,
  ],
};

/**
 * The `unblock` smoke cases. Judge rows, read by proxies: they report and never
 * gate. `suite/__tests__/unblock.test.ts` holds every one to `quarantined`.
 */
export const unblockSmokeCases: EvalCase[] = [
  unblockSmokeConnectGmailNoForkCase,
  unblockSmokeBestGuessDeckCase,
  unblockSmokeKeepsGoingCase,
  unblockSmokeUnrelatedBugCase,
  unblockSmokeCantDoClosestWayCase,
];
