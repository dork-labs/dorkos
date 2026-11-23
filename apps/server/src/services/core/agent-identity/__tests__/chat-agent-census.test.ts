/**
 * Census: a chat's agent is compared with a caller only through `session-agent`
 * (DOR-5038, Security's ruling).
 *
 * A chat started with only a folder records no agent, for good, and resolving
 * it is `session-agent`'s job: the recorded agent, else the agent whose home
 * the chat's server-held folder is, failing closed. A raw comparison on the
 * recorded value reads that chat as nobody's. This fails when a file that reads
 * chat records compares a chat's agent anywhere outside that module and the
 * allowlist below, or when an allowlisted file gains one.
 *
 * What it matches, in files that read `sessionMetadata`, `sessionFacts(` or
 * `getSessionAgentPath(`: `.agentPath ===`/`!==` on a chat-record name (either
 * side), a variable assigned from `getSessionAgentPath(` compared the same way,
 * `getSessionAgentPath(...)` compared directly, and SQL filters on
 * `sessionMetadata.agentPath`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeOnly } from '../../../../../../../scripts/lib/code-only.mjs';

const SRC = path.resolve(__dirname, '../../../..');

/** The module whose job this is. */
const OWNER = 'services/core/agent-identity/session-agent.ts';

/** Names that hold a chat's record in the files in scope. */
const RECORD_NAMES = [
  'session',
  'target',
  'source',
  'metadata',
  'sourceMetadata',
  'row',
  'facts',
  'current',
  'meta',
];

/**
 * Every allowed comparison, by file: how many there are, and why each may stay.
 * A new one in any file, listed or not, fails until it goes through
 * `session-agent` or is listed here with a reason.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'services/canvas/doc-channel/authorization.ts': {
    count: 1,
    why: 'runtime claims are minted only when the stored agent equals them, so NULL gets none',
  },
  'services/canvas/doc-channel/downstream/authority.ts': {
    count: 2,
    why: 'a grant snapshot vs claims, and the chat vs runtime claims; NULL refuses',
  },
  'services/canvas/doc-channel/http-composition.ts': {
    count: 2,
    why: 'a page route target must be a chat recorded for that agent; NULL refuses (slice C may widen)',
  },
  'services/canvas/doc-channel/identity/identity-target.ts': {
    count: 3,
    why: 'the approved target was captured from a recorded chat, so NULL refuses; nothing widens',
  },
  'services/canvas/doc-channel/lifecycle.ts': {
    count: 1,
    why: 'the receipt’s origin agent is never NULL, so a NULL chat only blocks a queue move',
  },
  'services/connectors/agent-request-authority.ts': {
    count: 2,
    why: 'the origin comes from runtime claims, which need the stored agent; NULL refuses',
  },
  'services/connectors/events/session-target.ts': {
    count: 1,
    why: 'event chats are bound with the origin’s agent, so they are never NULL',
  },
  'services/connectors/principal/runtime-authority-resolver.ts': {
    count: 2,
    why: 'connected apps refuse a chat with no recorded agent (DOR-2752), on purpose for now',
  },
  'services/core/runtime-registry.ts': {
    count: 1,
    why: 'lists chats bound to one agent as stored, for the session fan-out; never a check',
  },
  'services/core/runtime-seam/recovery-birth-source.ts': {
    count: 1,
    why: 'a room seat’s chat always records its agent; recovery compares two stored records',
  },
  'services/rooms/handoff/outbox/report-outbox-store.ts': {
    count: 1,
    why: 'a presence test: a report with no runtime and no agent is skipped',
  },
  'services/rooms/reseat/failed-seat-candidate.ts': {
    count: 1,
    why: 'only skips automatic reseat recovery for a NULL chat; never widens',
  },
  'services/rooms/reseat/required-launch-store.ts': {
    count: 1,
    why: 'source vs destination of a recovery; the insert copies no agent, so NULL stays NULL',
  },
  'services/session/local-browser/profile-access.ts': {
    count: 1,
    why: 'the same chat now vs when its browser opened, both from chatFactsOf; a lost folder refuses',
  },
  'startup/steps/connector-services.ts': {
    count: 1,
    why: 'not a chat record: a room member vs the mesh agent’s own path',
  },
};

/** Every non-test source file under `src`, relative to it. */
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [path.relative(SRC, full)] : [];
  });
}

/**
 * The variables that hold a chat's recorded agent: assigned from
 * `getSessionAgentPath(` directly, or unpacked from a `Promise.all` at its place.
 */
function trackedNames(text: string): string[] {
  const direct = [
    ...text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?[\w.?]*getSessionAgentPath\(/g),
  ].map((m) => m[1]!);
  const unpacked = [
    ...text.matchAll(/(?:const|let)\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\)/g),
  ].flatMap((m) => {
    const names = m[1]!.split(',').map((name) => name.trim());
    const at = m[2]!.split(/,\s*\n/).findIndex((part) => part.includes('getSessionAgentPath('));
    return at >= 0 && names[at] ? [names[at]] : [];
  });
  return [...direct, ...unpacked];
}

/** The chat-agent comparisons in one file's text. */
function comparisonsIn(text: string): string[] {
  const tracked = trackedNames(text);
  const patterns = [
    new RegExp(`\\b(?:${RECORD_NAMES.join('|')})\\??\\.agentPath\\s*[!=]==`),
    new RegExp(`[!=]==\\s*(?:${RECORD_NAMES.join('|')})\\??\\.agentPath\\b`),
    ...(tracked.length > 0
      ? [
          new RegExp(`\\b(?:${tracked.join('|')})\\s*[!=]==`),
          new RegExp(`[!=]==\\s*(?:${tracked.join('|')})\\b`),
        ]
      : []),
    /getSessionAgentPath\([^)]*\)\)?\s*[!=]==/,
    /\b(?:eq|ne|inArray)\(\s*sessionMetadata\.agentPath\b/,
  ];
  return codeOnly(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
}

describe('the chat agent census', () => {
  it('compares a chat’s agent only through session-agent, or with a listed reason', () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles()) {
      if (file === OWNER) continue;
      const text = fs.readFileSync(path.join(SRC, file), 'utf8');
      if (!/sessionMetadata|getSessionAgentPath\(|sessionFacts\(/.test(text)) continue;
      const lines = comparisonsIn(text);
      if (lines.length > 0) found[file] = lines;
    }
    const counts = Object.fromEntries(
      Object.entries(found).map(([file, lines]) => [file, lines.length])
    );
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED).map(([file, entry]) => [file, entry.count])
    );
    expect(counts, JSON.stringify(found, null, 2)).toEqual(allowed);
  });

  it('catches each shape it is for, and not a comment', () => {
    expect(
      comparisonsIn(
        [
          'if (session.agentPath !== caller.agentPath) return;',
          'if (caller.agentPath === row?.agentPath) return;',
          'const stored = await registry.getSessionAgentPath(id);',
          'if (stored !== caller) return;',
          'const [kind, owned] = await Promise.all([',
          '  readKind(id),',
          '  registry.getSessionAgentPath(id),',
          ']);',
          'if (owned === caller) return;',
          'if ((await registry.getSessionAgentPath(id)) === null) return;',
          'db.select().from(sessionMetadata).where(eq(sessionMetadata.agentPath, x));',
          '// session.agentPath === x in a comment',
          'if (claims.agentPath === agent.projectPath) return;',
        ].join('\n')
      )
    ).toHaveLength(6);
  });

  // DOR-5038: these read a chat's agent only through session-agent. Most of this wiring has no
  // test of its own, so the recorded-only read coming back here fails this instead.
  it.each([
    'services/heartbeats/gatherers/open-work-reader.ts',
    'services/relay/adapter-factory.ts',
    'services/session/fleet/carry-over.ts',
    'services/session/local-browser/outside-turn.ts',
    'startup/steps/doc-delivery.ts',
    'startup/steps/local-browser-wiring.ts',
  ])('%s reads the chat’s agent through session-agent', (file) => {
    const code = codeOnly(fs.readFileSync(path.join(SRC, file), 'utf8'));
    expect(code).not.toContain('getSessionAgentPath(');
    expect(code).toMatch(/\b(?:sessionAgentById|sessionAgentOf|chatFactsOf)\(?/);
  });

  // chat_read's description names the chat's agent (DOR-5038, slice C). The rest of the file
  // still reads the recorded agent for report-back routing, so only this block is pinned.
  it('chat_read names the chat’s agent through session-agent', () => {
    const code = codeOnly(
      fs.readFileSync(
        path.join(SRC, 'services/session/chat-messages/chat-message-wiring.ts'),
        'utf8'
      )
    );
    const describe = code.slice(code.indexOf('describe: async'), code.indexOf('search: async'));
    expect(describe).toContain('sessionAgentById(');
    expect(describe).not.toContain('getSessionAgentPath(');
  });

  it('gives every listed file a reason', () => {
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(entry.why.length, file).toBeGreaterThan(10);
    }
  });
});
