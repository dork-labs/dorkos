/**
 * Whether the copy on disk is still the one a person was shown when they
 * answered its approval card (DOR-2517, DOR-2686). Split from
 * `extension-manager.ts` to keep it under its size ratchet.
 *
 * @module services/extensions/pin/extension-expected-copy
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { declaredSet, isCovered } from '../isolation/permission-coverage.js';

/**
 * The copy a person was shown when they answered: its path and version, and
 * the plugin that carried it when the caller knows it (`null` for a direct
 * install; absent means "not compared").
 */
export interface ExpectedCopy {
  /** Absent when the caller does not know it (the Settings card); then not compared. */
  path?: string;
  version: string;
  plugin?: string | null;
  /**
   * The permission set the person was shown (DOR-2686); absent means "not
   * compared". The copy must ask for nothing outside it: equal or narrower
   * approves (recording what it declares now), wider is stale.
   */
  permissions?: ApprovedPermissionSet;
}

/**
 * Whether the record on disk is still exactly the copy a person was shown
 * (DOR-2517). An answer to an out-of-date row must never land on a copy that
 * took that one's place — another plugin, a project folder reusing the id, or
 * a newer version.
 *
 * @param record - The extension record now.
 * @param expected - The copy the person's row showed.
 */
export function isExpectedCopy(record: ExtensionRecord, expected: ExpectedCopy): boolean {
  if (expected.path !== undefined && path.resolve(expected.path) !== path.resolve(record.path)) {
    return false;
  }
  if (expected.version !== record.manifest.version) return false;
  if (expected.plugin !== undefined && expected.plugin !== (record.sourcePlugin ?? null)) {
    return false;
  }
  // The yes covers what the card showed. A copy that narrowed since asks for
  // nothing the person did not see, and the approval records what it declares
  // now (the narrower set), so it is approved; one that widened is stale.
  if (
    expected.permissions !== undefined &&
    !isCovered(declaredSet(record.manifest), expected.permissions)
  ) {
    return false;
  }
  return true;
}
