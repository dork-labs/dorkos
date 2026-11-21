/** Link card text and its exact narrowing round-trip; shared with the apply check. */
import path from 'node:path';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { disclosesAnything, type DevLinkPreview } from '@dorkos/shared/marketplace-schemas';
import { isCovered } from '../../extensions/isolation/permission-coverage.js';
import { describeEffectsInFull } from '../preview/disclosed-effects.js';
// One source for the per-app card line, places included (DOR-4282).
import { describePermissionSet, parsePermissionSet } from './permission-card-line.js';

/** App declarations captured once for the card and the permission grant. */
export interface LinkCardSets {
  permissions: Record<string, ApprovedPermissionSet>;
  servers: Record<string, boolean>;
  appSecrets: Record<string, { key: string; required: boolean }[] | undefined>;
}

/**
 * Whether a card's text differs from the folder's description now only in
 * extensions that ask for less than the card listed (DOR-2686). Every other
 * line must match exactly, each listed set must read back to the very text
 * the card showed, and each extension's set now must be covered by the one
 * shown, so a yes is never stretched over anything the person did not see.
 *
 * @param shown - The card text the person approved.
 * @param plan - The folder as it is now.
 * @param replaceInstalled - Whether the link sets an installed copy aside.
 */
export function onlyNarrowed(
  shown: string,
  plan: LinkCardSets & { preview: DevLinkPreview },
  replaceInstalled: boolean
): boolean {
  const shownLines = shown.split('\n');
  const nowLines = describePlan(plan.preview, replaceInstalled, plan).split('\n');
  if (shownLines.length !== nowLines.length) return false;
  const shownSets: Record<string, ApprovedPermissionSet> = {};
  for (const id of plan.preview.extensions) {
    const prefix = `${id}: `;
    const index = nowLines.findIndex((line) => line.startsWith(prefix));
    if (index < 0 || !shownLines[index]!.startsWith(prefix)) return false;
    const parsed = parsePermissionSet(shownLines[index]!.slice(prefix.length));
    if (!parsed || !isCovered(plan.permissions[id]!, parsed)) return false;
    shownSets[id] = parsed;
  }
  // Rebuilt from what was read back, the card must be exactly what was shown.
  return (
    describePlan(plan.preview, replaceInstalled, { ...plan, permissions: shownSets }) === shown
  );
}

/**
 * The approval card text for a planned link. Deterministic, so the same folder
 * describes the same way at the card and at the retry.
 */
export function describePlan(
  preview: DevLinkPreview,
  replaceInstalled: boolean,
  sets: LinkCardSets
): string {
  const lines = [
    `Folder: ${preview.path}`,
    `Package: ${preview.name} (${preview.type})`,
    preview.scope === 'global'
      ? 'Runs in: every chat'
      : `Runs in: the project at ${path.dirname(path.dirname(path.dirname(preview.slot)))}`,
  ];
  if (preview.replaces && replaceInstalled) {
    lines.push(`Sets aside: the installed copy (v${preview.replaces.version}), not deleted`);
  }
  lines.push(
    `Extensions it may run: ${preview.extensions.length > 0 ? preview.extensions.join(', ') : 'none'}`
  );
  // What each may reach, in full (DOR-2686): the yes records exactly these
  // sets, and is bound to this text, so a folder that widens one before the
  // click describes differently and is asked about again.
  for (const id of preview.extensions) {
    const set = sets.permissions[id];
    if (set) lines.push(`${id}: ${describePermissionSet(set, sets.servers[id] ?? true)}`);
    const secrets = sets.appSecrets[id];
    lines.push(
      `Secrets for ${JSON.stringify(id)}: ${secrets === undefined ? 'declarations could not be read' : secrets.length === 0 ? 'none declared' : secrets.map((secret) => `${JSON.stringify(secret.key)} (${secret.required ? 'required' : 'optional'})`).join(', ')}`
    );
  }
  // Every hook, server and program in full, never a count: the yes records
  // approval for exactly these (the global-activation and hook decisions,
  // `consent.ts`), and the approval is bound to this text, so a hook moved to
  // another event, or a changed command, is a different card.
  lines.push('It runs on its own:');
  lines.push(
    ...describeEffectsInFull(
      preview.effects,
      preview.scope === 'global'
        ? 'in every chat'
        : 'declared, but not started for a project install',
      preview.extensions.some((id) => sets.servers[id] !== false)
    )
  );
  if (preview.scope === 'global' && preview.effects && disclosesAnything(preview.effects)) {
    lines.push('Approving lets these start in every chat.');
  } else if (preview.scope === 'project' && (preview.effects?.hooks.length ?? 0) > 0) {
    lines.push('Approving lets its hooks run in this project.');
  }
  lines.push(
    'Anything new it adds later asks first. Edits to this folder run without another card.'
  );
  return lines.join('\n');
}
