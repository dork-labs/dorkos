/** Compare running copies separately from the facts their cards show. */
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { extensionDeclarationDigest } from '../agent-tools/declaration-digest.js';
import { isolationKeyOf } from '../isolation/isolation-view.js';
import { mayRunExtensionCode, type ExtensionApprovals } from '../extension-load-policy.js';
import { toPublic } from '../extension-manager-types.js';

/** The runtime identity and visible state captured before discovery replaces a record. */
export interface ExtensionCopyState {
  path: string;
  runPath: string | null;
  runs: boolean;
  declarations: string;
  isolation: string;
  shown: string;
}

/** Capture a copy before the scan can update its approval or its record. */
export function extensionCopyState(
  record: ExtensionRecord,
  approvals: ExtensionApprovals
): ExtensionCopyState {
  const shown = toPublic(record, approvals);
  return {
    path: path.resolve(record.path),
    runPath: record.runPath ?? null,
    runs: mayRunExtensionCode(record, approvals),
    declarations: extensionDeclarationDigest(record.manifest),
    isolation: JSON.stringify(isolationKeyOf(record)),
    // Activation is a browser acknowledgement, not a change to the copy.
    shown: JSON.stringify({
      ...shown,
      status: shown.status === 'active' ? 'compiled' : shown.status,
    }),
  };
}

/** Whether the server must stop or start, rather than only refresh its card. */
export function runningCopyChanged(
  before: ExtensionCopyState | undefined,
  after: ExtensionCopyState
): boolean {
  return (
    !before ||
    before.path !== after.path ||
    before.runPath !== after.runPath ||
    before.runs !== after.runs ||
    (after.runs && before.declarations !== after.declarations) ||
    (after.runs && before.isolation !== after.isolation)
  );
}
