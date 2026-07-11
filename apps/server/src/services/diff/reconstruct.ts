/**
 * Reconstruct a file's pre-edit image from an edit tool's input — the diff
 * base's "Fallback A" rung (DOR-212 §Q1).
 *
 * The precise base is the pre-tool disk snapshot ({@link ./edit-baseline}); this
 * is the fallback for when no snapshot was captured (a runtime without a
 * synchronous pre-tool seam, or a snapshot missed because the server restarted
 * mid-session). `Edit`/`MultiEdit` inputs are reversible — reverse-applying
 * `new_string` → `old_string` against the current (post-edit) disk content
 * recovers the pre-image. `Write` carries only the new full content, so a
 * Write-first file has no recoverable pre-image and falls through to the HEAD /
 * empty rungs (this returns `null`).
 *
 * @module services/diff/reconstruct
 */

/** One `MultiEdit` replacement pair. */
interface EditPair {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Replace occurrences of `find` with `replace` in `haystack` (first-only unless
 * `all`).
 *
 * Caveat: the first-only path reverses at the FIRST `indexOf` match of
 * `new_string`, but the original Edit replaced the first occurrence of
 * `old_string` — when `new_string` also occurs EARLIER in the post-edit text
 * than the edited site, the reversal picks the wrong occurrence and the
 * reconstructed pre-image is off. Accepted: this is the last-resort fallback
 * rung (only reached with no pre-tool snapshot), the tool's own uniqueness
 * requirement on `old_string` makes ambiguous cases rare, and a wrong base can
 * only produce a confusing diff — never a bad write (rejects stay hash-
 * conditioned against disk).
 */
function applyReplace(
  haystack: string,
  find: string,
  replace: string,
  all: boolean
): string | null {
  if (find === '') return null;
  if (!haystack.includes(find)) return null;
  if (all) return haystack.split(find).join(replace);
  const idx = haystack.indexOf(find);
  return haystack.slice(0, idx) + replace + haystack.slice(idx + find.length);
}

/**
 * Recover the pre-edit content of a file from an edit tool's input and the
 * current (post-edit) content, or `null` when it can't be reversed (a `Write`, or
 * a replacement whose `new_string` is no longer present on disk).
 *
 * @param toolName - The edit-family tool name (`Edit` | `MultiEdit` | `Write` | `NotebookEdit`).
 * @param input - The tool's parsed input object.
 * @param current - The file's current on-disk text (post-edit).
 */
export function reconstructPreImage(
  toolName: string,
  input: Record<string, unknown>,
  current: string
): string | null {
  if (toolName === 'Edit') {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : null;
    const newStr = typeof input.new_string === 'string' ? input.new_string : null;
    if (oldStr === null || newStr === null) return null;
    const replaceAll = input.replace_all === true;
    // Reverse the edit: put the old_string back where the new_string now sits.
    return applyReplace(current, newStr, oldStr, replaceAll);
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as EditPair[]) : null;
    if (!edits) return null;
    // MultiEdit applies its edits in order, so reverse them in the opposite order
    // to peel back to the pre-image.
    let text = current;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') return null;
      const reverted = applyReplace(text, e.new_string, e.old_string, e.replace_all === true);
      if (reverted === null) return null;
      text = reverted;
    }
    return text;
  }

  // `Write` (full-content overwrite) and `NotebookEdit` (cell-structured, not a
  // plain-text reversal) carry no recoverable pre-image from the input alone.
  return null;
}
