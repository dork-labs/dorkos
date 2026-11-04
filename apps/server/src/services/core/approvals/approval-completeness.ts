/** Rebuild package cards from their full request before accepting a yes. */
import { z } from 'zod';
import { APPROVAL_FULL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import type { ApprovalRow } from './approval-card.js';
import type { ApprovalRequestInput } from './approval-request-input.js';
import { storableSummary, storableDetail } from './approval-storable.js';
import { redactSecretsInText, quoteSummaryValue } from './approval-summary.js';
import {
  hasHiddenCardCharacters,
  hookCardIsComplete,
  summariseHookProjection,
} from '../../harness/hook-card.js';

/** The exact explanation shown on a decline-only card. */
export const INCOMPLETE_APPROVAL_MESSAGE =
  "This request can't be shown in full, so it can't be allowed yet.";

const hookRequest = z.object({
  kind: z.literal('hooks'),
  request: z.object({
    projectPath: z.string(),
    packageName: z.string(),
    hooks: z.array(
      z.object({ event: z.string(), matcher: z.string().optional(), command: z.string() })
    ),
    scripts: z
      .array(z.tuple([z.string(), z.string()]).readonly())
      .readonly()
      .optional(),
  }),
  options: z.object({ notInstalledByDorkos: z.boolean().optional() }).optional(),
});
const globalRequest = z.object({
  kind: z.literal('global'),
  name: z.string(),
  summary: z.string(),
  detail: z.string(),
});
const packageRequest = z.discriminatedUnion('kind', [hookRequest, globalRequest]);

/** Full decision-bearing input for the two package execution cards. */
export type PackageApprovalRequest = z.infer<typeof packageRequest>;

/** Only the two package execution cards require a full stored request. */
function requiresCompleteCard(capabilityId: string): boolean {
  return (
    capabilityId === 'harness.project_hooks' ||
    capabilityId === 'marketplace.activate_global_plugin'
  );
}

/** Store the full request only when it fits and contains no secret-shaped text. */
export function storablePackageRequest(input: ApprovalRequestInput): string | null {
  if (!requiresCompleteCard(input.capabilityId) || !input.packageRequest) return null;
  const parsed = packageRequest.safeParse(input.packageRequest);
  if (!parsed.success) return null;
  const full = parsed.data;
  const text = JSON.stringify(full);
  // Script fingerprints are server-computed hashes, not credentials. Keep them
  // whole for reconstruction; sweep every path and caller-controlled value.
  const secretsChecked = JSON.stringify(
    full.kind === 'hooks'
      ? {
          ...full,
          request: { ...full.request, scripts: full.request.scripts?.map(([file]) => file) },
        }
      : full
  );
  // A withheld request can be larger than any card. Never store an unbounded blob
  // or an unswept secret just to let it be declined. Missing data fails closed.
  return text.length <= APPROVAL_FULL_DETAIL_MAX_LENGTH &&
    redactSecretsInText(secretsChecked) === secretsChecked
    ? text
    : null;
}

/** Rebuild from full input at every read, grant and token retry; never infer from ellipses. */
export function cannotAllowCard(
  row: Pick<ApprovalRow, 'capabilityId' | 'packageRequest' | 'summary' | 'detail'>
): boolean {
  if (!requiresCompleteCard(row.capabilityId)) return false;
  try {
    const full = packageRequest.parse(JSON.parse(row.packageRequest ?? 'null'));
    if (full.kind === 'hooks') {
      const summary = summariseHookProjection(full.request, full.options);
      return (
        row.capabilityId !== 'harness.project_hooks' ||
        !hookCardIsComplete(full.request) ||
        summary !== row.summary ||
        storableSummary(summary) !== summary
      );
    }
    return (
      row.capabilityId !== 'marketplace.activate_global_plugin' ||
      [full.name, full.summary, full.detail].some(hasHiddenCardCharacters) ||
      quoteSummaryValue(full.name) !== JSON.stringify(full.name) ||
      full.summary !== row.summary ||
      storableSummary(full.summary) !== full.summary ||
      full.detail !== row.detail ||
      storableDetail(full.detail) !== full.detail
    );
  } catch {
    return true;
  }
}

/** A whole swept package name for a decline-only title, with a neutral fallback. */
export function incompletePackageLabel(stored: string | null): string {
  try {
    const full = packageRequest.parse(JSON.parse(stored ?? 'null'));
    const name = full.kind === 'hooks' ? full.request.packageName : full.name;
    const swept = quoteSummaryValue(name);
    // Never present a partial package identity as if it were the whole name.
    return name.trim() && !hasHiddenCardCharacters(name) && swept === JSON.stringify(name)
      ? JSON.parse(swept)
      : 'This package';
  } catch {
    return 'This package';
  }
}
