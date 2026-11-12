/** OpenCode's file permissions, checked before grants and automatic approval. */
import type { ApprovalEvent } from '@dorkos/shared/types';
import {
  isProtectedPath,
  isProtectedNativeWrite,
  searchTouchesProtectedPath,
  type ProtectedPathRoots,
} from '../../shared/policy/protected-path-check.js';

/** A read or edit permission's concrete paths; malformed file asks fail closed. */
export function protectedFileVerdict(
  approval: Pick<ApprovalEvent, 'toolName' | 'input'>,
  roots: ProtectedPathRoots
): 'deny' | 'allow' | undefined {
  const search = ['grep', 'glob'].includes(approval.toolName);
  const read = approval.toolName === 'read';
  const write = approval.toolName === 'edit';
  if (!read && !write && !search) return undefined;
  let details: Record<string, unknown>;
  try {
    details = JSON.parse(approval.input);
  } catch {
    return 'deny';
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return 'deny';
  if (search) {
    // Set from the correlated native tool input by mapPermissionAsked. Without
    // a concrete root, never assume the pattern means the working directory.
    const root = details.dorkosSearchRoot;
    if (typeof root !== 'string') return 'deny';
    return searchTouchesProtectedPath(root, roots) ? 'deny' : 'allow';
  }

  const paths: string[] = [];
  for (const key of ['filepath', 'filePath', 'path']) {
    if (typeof details[key] === 'string') paths.push(details[key]);
  }
  if (Array.isArray(details.files)) {
    for (const file of details.files) {
      if (!file || typeof file !== 'object') return 'deny';
      for (const key of ['filePath', 'movePath']) {
        if (typeof file[key] === 'string') paths.push(file[key]);
      }
    }
  }
  // Reads carry a single concrete path in patterns. Edit may carry worktree-relative paths.
  if (paths.length === 0 && Array.isArray(details.patterns)) {
    for (const item of details.patterns) {
      if (typeof item === 'string' && !/[?*]/.test(item)) paths.push(item);
    }
  }
  if (paths.length === 0) return 'deny';
  const denied = paths.some(
    (file) => (write && isProtectedNativeWrite(file, roots)) || isProtectedPath(file, 'read', roots)
  );
  return denied ? 'deny' : read ? 'allow' : undefined;
}
