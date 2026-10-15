import fs from 'node:fs';
import path from 'node:path';
import type { DbTransaction } from '@dorkos/db';
import { isContained } from '../../../../lib/boundary.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { readDocSourceDescriptor } from '../current/doc-source-policy.js';
import { readOriginalHttpPrincipalMembershipView } from '../http-composition.js';

/** Read the original source root only through the actual private HTTP composition view. */
export function readOriginalHttpSourceRoot(
  ownerKey: object,
  documentId: string,
  tx?: DbTransaction
): string | null {
  const deps = readOriginalHttpPrincipalMembershipView(ownerKey).deps;

  const source = readDocSourceDescriptor(deps, documentId, tx);
  if (!source.sourcePath) return null;
  const canonicalRoot = fs.realpathSync(source.rootCandidate!);
  if (source.matchRoot && fs.realpathSync(source.matchRoot) !== canonicalRoot)
    throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  if (source.allowedRoot && !isContained(canonicalRoot, fs.realpathSync(source.allowedRoot)))
    throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  const file = fs.realpathSync(path.resolve(canonicalRoot, source.sourcePath));
  if (!isContained(file, canonicalRoot)) throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  return canonicalRoot;
}

/** Preserve the original source-root catch classification after private composition selection. */
export function readOriginalHttpSourceRootOrRefuse(
  ownerKey: object,
  documentId: string,
  tx?: DbTransaction
): string | null {
  try {
    return readOriginalHttpSourceRoot(ownerKey, documentId, tx);
  } catch (error) {
    if (error instanceof DocRouteGrantError || error instanceof DocChannelNotFoundError)
      throw error;
    throw new DocRouteGrantError('LOCAL_SOURCE_UNAVAILABLE');
  }
}
