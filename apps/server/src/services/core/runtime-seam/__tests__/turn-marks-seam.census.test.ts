/**
 * Every runtime that can run a turn applies turn marks (DOR-3036, `specs/turn-marks`). The marks
 * take effect at one seam, `applyTurnMarks`, which `recordTurnLevels` wraps around the level
 * record and `decorateRuntime` puts on every runtime `RuntimeRegistry.register` stores. A runtime
 * that reached a turn any other way would run with its marks ignored, so this census fails on:
 *
 * - a second writer of the registry's runtime map, or a second registry;
 * - a runtime class nobody has checked is registered (a new `implements AgentRuntime`);
 * - a file that builds a runtime without handing it to `register` (built-ins, the test runtime,
 *   DorkOS's own, and the agent computer bridge);
 * - a registered runtime, of any type and registered at any time, whose marked turns are not
 *   counted while they run, for a turn sent to it and for one it starts on its own.
 *
 * If this fails, route the runtime through `RuntimeRegistry.register`; do not loosen the census.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { RuntimeRegistry } from '../../runtime-registry.js';
import { agentMarksRunning, resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every non-test source file under `apps/server/src` whose text matches `pattern`. */
function sourcesMatching(pattern: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['grep', '-lE', pattern, '--', '.', ':!**/__tests__/**'], {
      cwd: SERVER_SRC,
      encoding: 'utf8',
    });
  } catch {
    // `git grep` exits 1 when nothing matches.
    return [];
  }
  return out.split('\n').filter(Boolean).sort();
}

/** The runtime classes checked to be registered; a new one must be added here, deliberately. */
const RUNTIME_CLASSES = [
  'ClaudeCodeRuntime',
  'CodexRuntime',
  'DoeRuntime',
  'OpenCodeRuntime',
  'TestModeRuntime',
];

/** Builders allowed to construct a runtime without registering it: they return one to a caller that does. */
const BUILDERS = new Map<string, string>([
  [
    'services/runtimes/opencode/computer/index.ts',
    'builds the agent computer bridge; `startup/computers.ts` registers `bridge.runtime`',
  ],
]);

describe('the registry is the only way to a runtime', () => {
  it('has one writer of its runtime map, and it wraps every runtime in decorateRuntime', () => {
    const source = readFileSync(path.join(SERVER_SRC, 'services/core/runtime-registry.ts'), 'utf8');
    const writes = source.match(/this\.runtimes\.set\(/g) ?? [];
    expect(writes).toHaveLength(1);
    const write = source.slice(source.indexOf('this.runtimes.set('));
    expect(write.slice(0, 200)).toMatch(
      /this\.runtimes\.set\(\s*runtime\.type,\s*decorateRuntime\(/
    );
  });

  it('is the only registry anyone builds', () => {
    expect(sourcesMatching('new RuntimeRegistry\\(')).toEqual([
      'services/core/runtime-registry.ts',
    ]);
  });

  it('knows every runtime class there is', () => {
    const declared = sourcesMatching('class [A-Za-z]+ (extends [A-Za-z]+ )?implements AgentRuntime')
      .flatMap((file) =>
        [
          ...readFileSync(path.join(SERVER_SRC, file), 'utf8').matchAll(
            /class ([A-Za-z]+) (?:extends [A-Za-z]+ )?implements AgentRuntime/g
          ),
        ].map((match) => match[1]!)
      )
      .sort();
    expect(declared).toEqual(RUNTIME_CLASSES);
  });

  it('hands every runtime it builds to register, the agent computer bridge included', () => {
    const builds = sourcesMatching(
      `new (${RUNTIME_CLASSES.join('|')})\\(|createComputerRuntime\\(\\{`
    ).filter((file) => !BUILDERS.has(file));
    expect(builds).toContain('startup/computers.ts');
    const unregistered = builds.filter(
      (file) => !/[rR]egistry\.register\(/.test(readFileSync(path.join(SERVER_SRC, file), 'utf8'))
    );
    expect(unregistered).toEqual([]);
  });
});

describe('every registered runtime applies turn marks', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    resetLiveOutsiderTurns();
    root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-turn-marks-census-'));
    home = path.join(root, 'agents', 'scout');
    await mkdir(home, { recursive: true });
    registerTestHomes([home]);
  });

  afterEach(async () => {
    clearTestHomes();
    resetLiveOutsiderTurns();
    await rm(root, { recursive: true, force: true });
  });

  /** A runtime of `type` whose turns stay open until read, and that can start one on its own. */
  function fake(type: string) {
    let wake: ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
    const runtime = {
      type,
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      getSessionCwd: () => home,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      onRuntimeTurn: (listener: typeof wake) => {
        wake = listener;
        return () => undefined;
      },
    } as unknown as AgentRuntime;
    return {
      runtime,
      startOwnTurn: (id: string, events: AsyncIterable<StreamEvent>) => wake!(id, events),
    };
  }

  const marked: MessageOpts = { permissionCeiling: 'runtime-default' };

  // The built-ins, the test runtimes, DorkOS's own, the agent computer bridge
  // (`computer-local`, `startup/computers.ts`), and a runtime registered late,
  // after the others, as an extension or a reload would.
  it.each([
    'claude-code',
    'codex',
    'opencode',
    'test-mode',
    'doe',
    'computer-local',
    'late-extension',
  ])(
    '%s: a marked turn is counted against its agent while it runs, an unmarked one is not',
    async (type) => {
      const registry = new RuntimeRegistry();
      for (const earlier of ['claude-code', 'codex']) {
        if (earlier !== type) registry.register(fake(earlier).runtime);
      }
      registry.register(fake(type).runtime);
      const runtime = registry.get(type);

      const plain = runtime.sendMessage(`${type}-plain`, 'hi', { cwd: home });
      await plain.next();
      expect(agentMarksRunning(home)).toEqual({});
      await plain.return(undefined);

      const turn = runtime.sendMessage(`${type}-marked`, 'hi', { ...marked, cwd: home });
      await turn.next();
      expect(agentMarksRunning(home)).toEqual({ outsider: true });
      await turn.return(undefined);
      expect(agentMarksRunning(home)).toEqual({});
    }
  );

  it('counts a turn a registered runtime starts on its own under a marked turn', async () => {
    const registry = new RuntimeRegistry();
    const { runtime, startOwnTurn } = fake('codex');
    registry.register(runtime);
    const registered = registry.get('codex');
    for await (const _event of registered.sendMessage('codex-wake', 'hi', {
      ...marked,
      cwd: home,
    })) {
      // drain
    }
    let own: AsyncIterable<StreamEvent> | undefined;
    registered.onRuntimeTurn!((_id, events) => {
      own = events;
    });
    startOwnTurn(
      'codex-wake',
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    const reading = own![Symbol.asyncIterator]();
    await reading.next();
    expect(agentMarksRunning(home)).toEqual({ outsider: true });
    await reading.return?.(undefined);
  });
});
