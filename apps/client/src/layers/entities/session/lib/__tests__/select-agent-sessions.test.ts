import { describe, it, expect } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils';
import { selectAgentSessions } from '../select-agent-sessions';

function makeSession(
  id: string,
  cwd: string | undefined,
  updatedAt = '2026-02-07T14:00:00Z'
): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt,
    permissionMode: 'default',
    runtime: 'claude-code',
    ...(cwd === undefined ? {} : { cwd }),
  };
}

describe('selectAgentSessions', () => {
  it('keeps a session started in a subfolder of the project (DOR-674)', () => {
    // The last filter between the server's answer and the sidebar. An exact
    // `cwd` match here re-dropped exactly the sessions the server had just
    // gone to some trouble to include.
    const sessions = [
      makeSession('root', '/work/project'),
      makeSession('nested', '/work/project/packages/api'),
    ];

    expect(selectAgentSessions(sessions, '/work/project').map((s) => s.id)).toEqual([
      'root',
      'nested',
    ]);
  });

  it('still gives no agent a session that has no cwd (DOR-202)', () => {
    expect(selectAgentSessions([makeSession('ghost', undefined)], '/work/project')).toEqual([]);
  });

  it('returns nothing when no agent is selected', () => {
    expect(selectAgentSessions([makeSession('root', '/work/project')], null)).toEqual([]);
  });

  it('sorts newest first', () => {
    const sessions = [
      makeSession('older', '/work/project/api', '2026-02-01T00:00:00Z'),
      makeSession('newer', '/work/project', '2026-03-01T00:00:00Z'),
    ];

    expect(selectAgentSessions(sessions, '/work/project').map((s) => s.id)).toEqual([
      'newer',
      'older',
    ]);
  });

  describe.each(DIRECTORY_MEMBERSHIP_VECTORS)(
    'membership vector: $name',
    ({ root, candidate, within }) => {
      it(`${within ? 'includes' : 'excludes'} it`, () => {
        // The client answers the SAME table as the server's OpenCode listing and
        // its per-agent fan-out — one rule, three call sites (DOR-674).
        const selected = selectAgentSessions([makeSession('candidate', candidate)], root);
        expect(selected.map((s) => s.id)).toEqual(within ? ['candidate'] : []);
      });
    }
  );
});
