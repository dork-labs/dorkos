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
 * included) and line-separator characters show as visible escapes, each rule is capped, and each
 * sits on its own indented line, so one rule can never pose as two or as a line of the card. The
 * whole normalized list is bound by its digest, not only the rules shown.
 *
 * @module services/tasks/agent-mode/agent-mode-asked-for
 */
import { createHash } from 'node:crypto';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { scheduleExecutionCopy } from '../../notifications/schedule-execution-copy.js';

/** How many requested rules the card lists before `+N more`; the box they sit in scrolls. */
const RULES_SHOWN = 50;

/** The most characters one rule, or an unknown mode id, shows. */
const RULE_MAX = 120;

/** The label {@link scheduleExecutionCopy} gives a mode neither the runtime nor DorkOS knows. */
const UNKNOWN_MODE = 'Unknown mode';

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
 * A requested mode as the runtime's mode picker names it ("Never ask"). A mode it does not know
 * keeps its id beside the label, made inert, so the person still sees what was asked.
 */
function modeLabel(mode: string, capabilities: RuntimeCapabilities | undefined): string {
  const label = scheduleExecutionCopy(mode, capabilities).modeLabel;
  return label === UNKNOWN_MODE ? `${UNKNOWN_MODE} (${capped(inertText(mode), RULE_MAX)})` : label;
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
 * mode other than the one decided, and the requested rules, one per line, with the version of the
 * whole request. Empty when it asked for neither.
 *
 * @param body - The call's body as the tool received it.
 * @param decidedMode - The mode the decision made of it.
 * @param capabilities - The task runtime's profile, for its mode picker's labels.
 */
export function askedForLines(
  body: Record<string, unknown>,
  decidedMode: string,
  capabilities: RuntimeCapabilities | undefined
): string[] {
  const lines: string[] = [];
  const raw = body.requestedPermissionMode;
  const mode = typeof raw === 'string' && raw !== '' && raw !== decidedMode ? raw : null;
  if (mode !== null) lines.push(`Asked for: ${modeLabel(mode, capabilities)}`);
  const rules = requestedRules(body);
  if (rules.length > 0) {
    lines.push('Also asked for these rules (not applied):');
    for (const rule of rules.slice(0, RULES_SHOWN))
      lines.push(`  - ${capped(inertText(rule), RULE_MAX)}`);
    if (rules.length > RULES_SHOWN) {
      lines.push(`  +${rules.length - RULES_SHOWN} more, all bound by the version below`);
    }
  }
  if (lines.length === 0) return lines;
  // The raw request, whole: what the lines above cut, escape or label is bound all the same.
  const digest = createHash('sha256').update(JSON.stringify({ mode, rules }), 'utf8').digest();
  return [...lines, `Request version: sha256:${digest.toString('base64url')}`];
}
