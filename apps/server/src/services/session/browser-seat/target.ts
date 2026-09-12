/**
 * How a driving tool names the one element it acts on, and what it says when
 * the naming is ambiguous.
 *
 * Three routes, exactly one of which must be given: an accessible role paired
 * with a name, some visible text, or a CSS selector. The rule is checked here
 * rather than in the page, so a call that names an element two ways is refused
 * in a sentence before anything is minted — a round trip the page could not have
 * resolved either.
 *
 * @module services/session/browser-seat/target
 */
import { z } from 'zod';
import type { BrowserTarget } from '@dorkos/shared/schemas';

/**
 * The element-naming fields every driving verb that takes a target advertises.
 *
 * Spread into a tool's input shape rather than nested, because the SDK builds
 * the tool's JSON Schema from exactly these keys and a nested object costs the
 * model a level of structure for nothing.
 */
export const TARGET_INPUT = {
  role: z
    .string()
    .optional()
    .describe(
      'An accessible role from the page outline, such as "button" or "link". Pair with name.'
    ),
  name: z
    .string()
    .optional()
    .describe(
      'The accessible name as the page outline printed it. Matched case-insensitively, whole string.'
    ),
  text: z
    .string()
    .optional()
    .describe('Visible text on the element. Use when the page has no roles worth naming.'),
  selector: z
    .string()
    .optional()
    .describe('A CSS selector. The last resort: it breaks whenever the markup changes.'),
  nth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Which match to act on when several fit. Leave it out and several matches is an error, not a guess.'
    ),
};

/**
 * The naming fields for the one verb that cannot offer the visible-text route.
 *
 * `browser_type` spends the `text` key on what it types, so a field named by its
 * visible text would be indistinguishable from the text going into it. Rather
 * than inventing a second spelling nobody would guess, that verb names its field
 * by role and name or by selector, and its description says so.
 */
export const TARGET_INPUT_NO_TEXT = {
  role: TARGET_INPUT.role,
  name: TARGET_INPUT.name,
  selector: TARGET_INPUT.selector,
  nth: TARGET_INPUT.nth,
};

/** Which browser tab a driving verb acts in. */
export const DOCUMENT_INPUT = {
  documentId: z
    .string()
    .optional()
    .describe(
      'Which browser tab to act in. Leave it out for the one whose window last brought a ' +
        'preview to the front. Ids come from get_ui_state.'
    ),
};

/** The naming fields as a tool receives them. */
export interface TargetInput {
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  nth?: number;
}

/** A resolved target, or the sentence that says why it could not be one. */
export type TargetResolution = { ok: true; target: BrowserTarget } | { ok: false; error: string };

/**
 * Turn a tool's naming fields into exactly one route, or refuse in a sentence.
 *
 * Zero routes and several routes get the SAME sentence on purpose: both are the
 * same mistake from the agent's side — the element was not named one way — and
 * one sentence that says how to name it is more useful than two that each
 * describe a different half of the rule.
 *
 * A `role` without a `name` is its own case, because it is the near miss: the
 * role alone matches every button on the page, and telling the agent to add the
 * name is a fix it can apply immediately.
 *
 * @param input - The naming fields, as the tool received them.
 * @param required - Whether a target must be given at all. `browser_type` and
 *   `browser_scroll` take an optional one; `browser_click` does not.
 */
export function resolveTargetInput(input: TargetInput, required: boolean): TargetResolution {
  const routes = [
    input.role !== undefined || input.name !== undefined,
    input.text !== undefined,
    input.selector !== undefined,
  ].filter(Boolean).length;

  if (routes === 0) {
    if (!required) return { ok: true, target: {} };
    return {
      ok: false,
      error:
        'Name the element one way — a role and name, some visible text, or a CSS selector — ' +
        'not several.',
    };
  }
  if (routes > 1) {
    return {
      ok: false,
      error:
        'Name the element one way — a role and name, some visible text, or a CSS selector — ' +
        'not several.',
    };
  }
  if ((input.role === undefined) !== (input.name === undefined)) {
    return {
      ok: false,
      error:
        'A role needs the name beside it, or every button on the page matches. Pass both, or ' +
        'name the element by its visible text instead.',
    };
  }
  return {
    ok: true,
    target: {
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.nth !== undefined ? { nth: input.nth } : {}),
    },
  };
}

/** Whether a target names any element at all (as opposed to "whatever has focus"). */
export function targetIsEmpty(target: BrowserTarget): boolean {
  return (
    target.role === undefined &&
    target.name === undefined &&
    target.text === undefined &&
    target.selector === undefined
  );
}
