/**
 * What an agent's `tasks_update` / `tasks_create` call asked for but this approval does not apply
 * (DOR-4335, Security D-5): a requested mode and requested rules, shown on the mode card so the
 * person sees them, and bound with it so a retry that asks for something else misses the grant.
 *
 * Only this call's own body is read, never the row's stored request: that is decided on the
 * schedule card's own Approve. A call that names neither adds no line, so the card text, and the
 * binding of every card already raised, stays byte-identical.
 *
 * Rule text is written by an agent, so it is untrusted on the card: control, format (bidi
 * included) and line-separator characters show as visible escapes, and each rule and the line
 * are capped. The whole normalized list is bound by its digest, not only the rules shown.
 *
 * @module services/tasks/agent-mode/agent-mode-asked-for
 */
import { createHash } from 'node:crypto';

/** How many requested rules the card lists before `+N more`. */
const RULES_SHOWN = 5;

/** The most characters one rule shows. */
const RULE_MAX = 120;

/** What separates the rules the card lists. */
const SEPARATOR = '·';

/** The most characters the whole rules line shows. */
const RULES_LINE_MAX = 600;

/** What a tool reply says when the call asked for rules (DOR-4335). Fixed: never echoes them. */
export const RULES_NOTE =
  "The rules you asked for wait for a person's own Approve. This call applied none.";

/** Control, format (bidi included) and line-separator characters, shown as escapes. */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * One agent-written value, made inert for the card: on one line, with every character that
 * could reorder or hide text shown as `\u{…}`.
 *
 * @param value - The raw value.
 */
export function inertText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(UNSAFE, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`)
    .trim();
}

/** A value cut to `max` characters, marked when cut. */
function capped(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * The requested rules of a call body as sent, trimmed, sorted and deduplicated. Raw, not escaped:
 * the binding digests these, so two rules that only look alike once escaped stay distinct.
 * `trim()` also drops edge whitespace like U+FEFF; a rule that differs only there runs the same.
 */
function requestedRules(body: Record<string, unknown>): string[] {
  const raw = body.requestedAllow;
  if (!Array.isArray(raw)) return [];
  const rules = raw.filter((rule): rule is string => typeof rule === 'string').map((r) => r.trim());
  return [...new Set(rules.filter((rule) => rule !== ''))].sort();
}

/**
 * Whether a call body asked for rules, which its tool reply then answers with {@link RULES_NOTE}.
 *
 * @param body - The call's body as the tool received it.
 */
export function askedForRules(body: Record<string, unknown>): boolean {
  return requestedRules(body).length > 0;
}

/**
 * The card lines for what this call asked for and does not apply: `Asked for:` when it names a
 * mode other than the one decided, and the requested rules with the digest of the whole list.
 * Empty when it asked for neither.
 *
 * @param body - The call's body as the tool received it.
 * @param decidedMode - The mode the decision made of it.
 */
export function askedForLines(body: Record<string, unknown>, decidedMode: string): string[] {
  const lines: string[] = [];
  const raw = body.requestedPermissionMode;
  const mode = typeof raw === 'string' && raw !== '' && raw !== decidedMode ? raw : null;
  if (mode !== null) lines.push(`Asked for: ${capped(inertText(mode), RULE_MAX)}`);
  const rules = requestedRules(body);
  if (rules.length > 0) {
    // Joined by a mark no rule can carry raw, so one rule cannot pose as two.
    const shown = rules
      .slice(0, RULES_SHOWN)
      .map((rule) => capped(inertText(rule).replaceAll(SEPARATOR, '\\u{B7}'), RULE_MAX));
    const more = rules.length > RULES_SHOWN ? ` +${rules.length - RULES_SHOWN} more` : '';
    const list = capped(shown.join(` ${SEPARATOR} `), RULES_LINE_MAX);
    lines.push(`Rules asked for (not applied): ${list}${more}`);
  }
  if (lines.length === 0) return lines;
  // The raw request, whole: what the lines above cut or escape is bound all the same.
  const digest = createHash('sha256').update(JSON.stringify({ mode, rules }), 'utf8').digest('hex');
  return [...lines, `Request version: ${digest}`];
}
