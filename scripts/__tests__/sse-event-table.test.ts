/**
 * The global stream's event list in `docs/integrations/sse-protocol.mdx` is
 * exactly what the one event union's table renders (DOR-4986). When this
 * fails, run `pnpm docs:sse-events` and commit the page.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DORKOS_EVENT_TYPES } from '../../packages/shared/src/dorkos-event-types.ts';
import {
  BEGIN_MARKER,
  END_MARKER,
  SSE_PROTOCOL_PAGE,
  renderEventTable,
  withEventTable,
} from '../lib/sse-event-table.ts';

const PAGE = join(resolve(import.meta.dirname, '../..'), SSE_PROTOCOL_PAGE);

describe('the SSE protocol page event list', () => {
  it('is what the union renders (run pnpm docs:sse-events)', async () => {
    const page = readFileSync(PAGE, 'utf8');
    expect(page).toBe(await withEventTable(page, PAGE));
  });

  it('lists every named type and the extension family', () => {
    const table = renderEventTable();
    for (const name of Object.keys(DORKOS_EVENT_TYPES)) {
      expect(table, name).toContain(`| \`${name}\` |`);
    }
    expect(table).toContain('| `ext:<extensionId>:<event>` |');
  });

  it('catches a stale list', async () => {
    const page = readFileSync(PAGE, 'utf8');
    const stale = page.replace('| `heartbeat`', '| `heartbeat_old`');
    expect(stale).not.toBe(page);
    expect(await withEventTable(stale, PAGE)).not.toBe(stale);
  });

  it('refuses a page without its markers', async () => {
    const page = readFileSync(PAGE, 'utf8');
    await expect(withEventTable(page.replace(BEGIN_MARKER, ''), PAGE)).rejects.toThrow(/markers/);
    await expect(withEventTable(page + END_MARKER, PAGE)).rejects.toThrow(/markers/);
  });
});
