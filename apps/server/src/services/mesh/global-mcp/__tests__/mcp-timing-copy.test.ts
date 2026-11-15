/**
 * The person and the agent are told one story about when an MCP change applies
 * (DOR-4113).
 *
 * Connections › MCP servers used to say open chats "may keep a server until they
 * stop", while agents were told a change reaches them next turn. DOR-3872 made
 * the second true for every change, Remove included, and put both client lines
 * on one sentence. They are pinned here beside the agent's line, so none of the
 * three can be reworded without the others being looked at.
 *
 * Reads the client's source, because the two halves live in apps that cannot
 * import each other and a copy of either string here would agree with itself.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDorkosAreasBlock } from '../../../runtimes/shared/awareness/dorkos-areas.js';

const CLIENT_UI = '../../../../../../client/src/layers/features/global-mcp-servers/ui/';
const PERSON_LINE = '<p>Changes reach every chat on its next message.</p>';

/** One client file's source text. */
function clientSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(CLIENT_UI + file, import.meta.url)), 'utf8');
}

describe('MCP change timing copy (DOR-4113)', () => {
  it('tells the person, on the tab and in Remove, what the agent is told', () => {
    for (const file of ['McpServersTab.tsx', 'RemoveServerDialog.tsx']) {
      expect(clientSource(file)).toContain(PERSON_LINE);
    }
    expect(buildDorkosAreasBlock()).toContain(
      'A change reaches you next turn, in this chat: no restart.'
    );
  });

  it('no longer tells the person that open chats keep a server', () => {
    for (const file of ['McpServersTab.tsx', 'RemoveServerDialog.tsx']) {
      expect(clientSource(file)).not.toMatch(/until they stop|reach new chats|New chats won/);
    }
  });
});
