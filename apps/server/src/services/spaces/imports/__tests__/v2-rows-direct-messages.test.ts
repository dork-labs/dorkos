/**
 * An export's direct-message row is checked for its shape as it is read (DOR-2955): private and
 * never joined on arrival, before the restore writes anything.
 */
import { describe, expect, it } from 'vitest';
import type { DataExportManifest } from '../v2-archive.js';
import { V2RowRules } from '../v2-rows.js';

const rules = new V2RowRules(
  { version: 2 } as DataExportManifest,
  { textBytes: 10_000, attachmentBytes: 10_000 },
  new Date()
);

const row = (change: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Direct message',
      description: null,
      visibility: 'private',
      archived: false,
      created_at: '2026-10-16T00:00:00.000Z',
      auto_join: false,
      kind: 'dm',
      dm_member_id: '22222222-2222-4222-8222-222222222222',
      dm_agent_id: '33333333-3333-4333-8333-333333333333',
      ...change,
    })
  );

describe('a direct message row in an export', () => {
  it('reads when it is private and never joined on arrival', () => {
    expect(rules.parse('channels', row())).toMatchObject({ kind: 'dm' });
  });

  it.each([
    ['public', { visibility: 'public' }],
    ['joined on arrival', { auto_join: true }],
  ])('is refused when %s', (_label, change) => {
    expect(() => rules.parse('channels', row(change))).toThrow(
      expect.objectContaining({ code: 'IMPORT_ARCHIVE_INVALID' })
    );
  });

  it('is refused naming only one of its two members', () => {
    expect(() => rules.parse('channels', row({ dm_agent_id: undefined }))).toThrow();
  });
});
