/**
 * The one place a projected attachment's path is computed.
 *
 * What is pinned here is the property the whole arrangement rests on: the path
 * the model is told and the path the projector writes are the SAME string,
 * because both come from this function. So the shape is asserted literally —
 * forward slashes, relative, entry-scoped — rather than by rebuilding it with
 * the same joins the implementation uses, which would agree with any mistake.
 */
import { describe, it, expect } from 'vitest';
import {
  PROJECTED_ATTACHMENTS_ROOT,
  projectedAttachmentPath,
  projectedEntryDir,
} from '../attachment-paths.js';

describe('projected attachment paths', () => {
  it('puts an entry’s files in their own directory under the sweep root', () => {
    expect(projectedEntryDir('01JENTRY')).toBe('.dork/.temp/room-attachments/01JENTRY');
    expect(projectedEntryDir('01JENTRY').startsWith(PROJECTED_ATTACHMENTS_ROOT)).toBe(true);
  });

  it('prefixes the name with the id, so two files called the same thing do not collide', () => {
    expect(projectedAttachmentPath('01JENTRY', '01JATT', 'crash.log')).toBe(
      '.dork/.temp/room-attachments/01JENTRY/01JATT-crash.log'
    );
    expect(projectedAttachmentPath('01JENTRY', '01JATT2', 'crash.log')).not.toBe(
      projectedAttachmentPath('01JENTRY', '01JATT', 'crash.log')
    );
  });

  it('uses forward slashes and stays relative, whatever platform it runs on', () => {
    const projected = projectedAttachmentPath('01JENTRY', '01JATT', 'crash.log');

    // `path.posix`, not `path.join`: this string goes into a model's context and
    // is compared against itself across runs, so it must not change shape on
    // Windows.
    expect(projected).not.toContain('\\');
    expect(projected.startsWith('.')).toBe(true);
  });
});
