import { describe, expect, it } from 'vitest';
import {
  MCP_RESERVED_NAME_ENTRIES,
  RESERVED_NAME_DEDUPE_MS,
  sayReservedNameServers,
} from '../global-mcp-reserved-name-notice.js';

const entry = MCP_RESERVED_NAME_ENTRIES['mcp-server.reserved_name'];

describe('mcp-server.reserved_name (DOR-4262)', () => {
  it("says it in the designer's words, and opens the server's sheet", () => {
    const p = { server: 'dorkos_connections' };
    expect(entry.title(p)).toBe('dorkos_connections stopped reaching your agents.');
    expect(entry.body?.(p)).toBe('Its name is now reserved for DorkOS. Rename it to fix this.');
    expect(entry.actions?.(p)).toEqual([{ id: 'open', label: 'Review', style: 'primary' }]);
    expect(entry.locate(p)).toEqual({ subjectId: 'mcp-server:dorkos_connections' });
  });

  it('says it once per server, for as long as the Inbox keeps a row, and never on a chat app', () => {
    expect(entry.dedupeKey?.({ server: 'DorkOS' })).toBe('mcp-reserved-name:DorkOS');
    expect(entry.dedupeKey?.({ server: 'dorkos' })).not.toBe(
      entry.dedupeKey?.({ server: 'DorkOS' })
    );
    expect(entry.dedupeWindowMs).toBe(RESERVED_NAME_DEDUPE_MS);
    expect(RESERVED_NAME_DEDUPE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(entry.relay).toBe('never');
    expect(entry.tier).toBe('notable');
  });

  it('is raised for every saved server named like DorkOS, and no other', () => {
    const said: string[] = [];
    sayReservedNameServers(
      [
        { name: 'github', reservedName: false },
        { name: 'DorkOS', reservedName: true },
        { name: 'dorkos_connections', reservedName: true },
      ],
      (server) => said.push(server)
    );
    expect(said).toEqual(['DorkOS', 'dorkos_connections']);
  });

  it('keeps the name as plain text, whatever it holds', () => {
    // A saved name can only be letters, numbers, - and _, but the line never
    // relies on that: it is a string, and the client renders it as text.
    const p = { server: '**bold**<img src=x>' };
    expect(entry.title(p)).toBe('**bold**<img src=x> stopped reaching your agents.');
  });
});
