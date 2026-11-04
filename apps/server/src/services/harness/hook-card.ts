/** Whole, reversible hook disclosures, shared by asking and granting. */
import { createHash } from 'node:crypto';
import { hashApprovalInput } from '../core/approvals/approval-input-hash.js';
import { resolve } from 'node:path';
import type { HookProjectionRequest } from './hook-consent.js';
import type { HookCardOptions } from './hook-approval.js';
import { quoteSummaryValue } from '../core/approvals/approval-summary.js';

/** The saved request identifies the presentation it was actually shown with. */
export const HOOK_CARD_PRESENTATION = 'detail-v1' as const;

/** Whether invisible formatting or control characters can change how text reads. */
export function hasHiddenCardCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
}

/** Quote a value reversibly, making every whitespace and control character visible. */
export function visibleHookValue(value: string): string {
  return JSON.stringify(value).replace(/[\p{White_Space}\p{Cc}\p{Cf}]/gu, (character) => {
    if (character === ' ') return character;
    let escaped = '';
    for (let i = 0; i < character.length; i++) {
      escaped += `\\u${character.charCodeAt(i).toString(16).padStart(4, '0')}`;
    }
    return escaped;
  });
}

/** One short sentence; the decision-bearing values live in the whole detail. */
export function summariseHookProjection(
  request: HookProjectionRequest,
  _options: HookCardOptions = {}
): string {
  const count = request.hooks.length;
  return `Review ${count} hook${count === 1 ? '' : 's'} before this package can run them.`;
}

/** Every value the hook consent binds, without a per-value cap or a short hash. */
export function describeHookProjection(request: HookProjectionRequest): string {
  const lines = [
    `Package: ${visibleHookValue(request.packageName)}`,
    `Working directory: ${visibleHookValue(resolve(request.projectPath))}`,
  ];
  request.hooks.forEach((hook, index) => {
    lines.push(
      '',
      `Hook ${index + 1}`,
      `Event: ${visibleHookValue(hook.event)}`,
      `Matcher: ${hook.matcher === undefined ? 'null' : visibleHookValue(hook.matcher)}`,
      `Command: ${visibleHookValue(hook.command)}`
    );
  });
  for (const [file, pin] of request.scripts ?? []) {
    lines.push('', `File: ${visibleHookValue(file)}`, `Fingerprint: ${visibleHookValue(pin)}`);
  }
  return lines.join('\n');
}

/** Package identity must survive the title's existing sweep and name cap whole. */
export function hookCardIsComplete(request: HookProjectionRequest): boolean {
  return (
    !hasHiddenCardCharacters(request.packageName) &&
    quoteSummaryValue(request.packageName) === JSON.stringify(request.packageName)
  );
}

/** Exact execution input, including the presentation the person is answering. */
export function hookRequestInputHash(request: HookProjectionRequest): string {
  return hashApprovalInput({
    presentation: HOOK_CARD_PRESENTATION,
    projectPath: resolve(request.projectPath),
    packageName: request.packageName,
    hooks: request.hooks.map((hook) => [hook.event, hook.matcher ?? null, hook.command]),
    scripts: request.scripts ?? [],
  });
}

/** Stable family across package edits and disclosure upgrades. */
export function hookRequestFamily(
  request: Pick<HookProjectionRequest, 'projectPath' | 'packageName'>
): string {
  return createHash('sha256')
    .update(`${resolve(request.projectPath)}\0${request.packageName}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}
