import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';

import { env as flags } from '../../../../env.js';
const originalFlags = {
  DORKOS_TEST_RUNTIME: flags.DORKOS_TEST_RUNTIME,
  DORKOS_REPLAY_RECORDING: flags.DORKOS_REPLAY_RECORDING,
};
const account = { productionHome: '' };
import { ReplaySource, MAX_RECORDING_BYTES } from '../replay/source.js';
import { ReplayHome } from '../replay/home.js';
import { REPLAY_HOME_MARKER } from '../../../../lib/replay/isolation.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { triggerTurn } from '../../../session/trigger-turn.js';

let sandbox: string;
let home: string;
const recording = (
  events = [{ type: 'text_delta', data: { text: 'Scout finished the sample task.' } }]
) => ({
  version: 1,
  title: 'Sample task',
  turns: [{ events }],
});
function writeRecording(value: unknown = recording()): void {
  fs.writeFileSync(path.join(home, 'reply.json'), JSON.stringify(value));
}
async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-replay-'));
  home = path.join(sandbox, 'demo');
  fs.mkdirSync(home);
  account.productionHome = path.join(sandbox, 'person', '.dork');
  fs.mkdirSync(account.productionHome, { recursive: true });
  vi.spyOn(os, 'userInfo').mockReturnValue({
    ...os.userInfo(),
    homedir: path.dirname(account.productionHome),
  });
  fs.writeFileSync(path.join(home, REPLAY_HOME_MARKER), 'demo-boot v1\n');
  flags.DORKOS_TEST_RUNTIME = true;
  flags.DORKOS_REPLAY_RECORDING = 'reply.json';
  vi.stubEnv('DORK_HOME', home);
  writeRecording();
});
afterEach(() => {
  disposeProjector('replay-chat');
  Object.assign(flags, originalFlags);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('recordings are display data', () => {
  it('shows chat_send and shell results without dispatching, spawning, or fetching', async () => {
    const sentinel = path.join(home, 'must-not-exist');
    const events = ['chat_send', 'Bash', 'post_to_room', 'memory_write'].flatMap(
      (toolName, index) => [
        {
          type: 'tool_call_start',
          data: {
            toolName,
            toolCallId: `tool-${index}`,
            status: 'running',
            input: JSON.stringify({ command: `touch ${sentinel}`, text: 'Sample only' }),
          },
        },
        {
          type: 'tool_result',
          data: {
            toolName,
            toolCallId: `tool-${index}`,
            status: 'complete',
            result: 'Sample result',
          },
        },
      ]
    );
    writeRecording({ version: 1, title: 'Sample tools', turns: [{ events }] });
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('No shell in replay');
    });
    const exec = vi.spyOn(childProcess, 'exec').mockImplementation(() => {
      throw new Error('No shell in replay');
    });
    const fetch = vi.fn(() => {
      throw new Error('No network in replay');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const runtime = new TestModeRuntime('test-mode', new ReplaySource(home, 'reply.json'));
      const result = await collect(runtime.sendMessage('tools', 'Run the sample', { cwd: home }));
      expect(result.filter((event) => event.type === 'tool_result')).toHaveLength(4);
      expect(result).toContainEqual({ type: 'done', data: { sessionId: 'tools' } });
      expect(spawn).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('labels every chat, renamed chat, live reply, and hydrated reply', async () => {
    const runtime = new TestModeRuntime('codex', new ReplaySource(home, 'reply.json'));
    runtime.ensureSession('replay-chat', { cwd: home, permissionMode: 'default' });
    expect((await runtime.listSessions(home))[0]?.title).toMatch(/^Recorded demo:/);
    const projector = getOrCreateProjector('replay-chat', home);
    const accepted = await triggerTurn({
      sessionId: 'replay-chat',
      clientId: 'demo-viewer',
      content: 'Show the sample',
      cwd: home,
      projector,
      deps: {
        acquireLock: (sid, cid, res) => runtime.acquireLock(sid, cid, res),
        releaseLock: (sid, cid) => runtime.releaseLock(sid, cid),
        sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
        rekeyProjector: () => {},
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getCapabilities: () => runtime.getCapabilities(),
      },
    });
    expect(accepted.accepted).toBe(true);
    await vi.waitFor(() => expect(projector.getStatus().lifecycle).toBe('idle'));
    const history = await runtime.getMessageHistory(home, 'replay-chat');
    expect(history.find((message) => message.role === 'assistant')?.content).toBe(
      'Recorded demo\n\nScout finished the sample task.'
    );
    expect(
      (await runtime.getSessionSnapshot({ cwd: home, permissionMode: 'default' }, 'replay-chat'))
        .messages
    ).toEqual(history);
    await runtime.renameSession('replay-chat', 'New sample title');
    expect((await runtime.findSession('replay-chat'))?.title).toBe(
      'Recorded demo: New sample title'
    );
  });

  it('plays separate turns once per session, without falling back after the last one', async () => {
    writeRecording({
      ...recording(),
      turns: [
        recording().turns[0],
        { events: [{ type: 'text_delta', data: { text: 'Second sample' } }] },
      ],
    });
    const source = new ReplaySource(home, 'reply.json');
    expect(await collect(source.play('one'))).toContainEqual({
      type: 'text_delta',
      data: { text: 'Scout finished the sample task.' },
    });
    expect(await collect(source.play('one'))).toContainEqual({
      type: 'text_delta',
      data: { text: 'Second sample' },
    });
    await expect(collect(source.play('one'))).rejects.toThrow('Recording finished');
    expect(await collect(source.play('two'))).toContainEqual({
      type: 'text_delta',
      data: { text: 'Scout finished the sample task.' },
    });
  });

  it.each([['```dorkos-ui\n{}\n```'], ['~~~dorkos-ui\n{}\n~~~'], ['```dor', 'kos-ui\n{}\n```']])(
    'rejects recorded widgets, including split fences %#',
    (...parts) => {
      writeRecording(recording(parts.map((text) => ({ type: 'text_delta', data: { text } }))));
      expect(() => new ReplaySource(home, 'reply.json')).toThrow('live widgets');
    }
  );

  it.each([
    'approval_required',
    'ui_command',
    'session_status',
    'done',
    'tool_approval',
    'canvas_update',
  ])('rejects the control event %s', (type) => {
    writeRecording({ ...recording(), turns: [{ events: [{ type, data: {} }] }] });
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
  });
  it('rejects unknown nested data including live MCP UI references', () => {
    writeRecording({
      ...recording(),
      turns: [
        {
          events: [
            {
              type: 'tool_result',
              data: {
                toolCallId: 'x',
                toolName: 'chat_send',
                status: 'complete',
                ui: { resourceUri: 'ui://live' },
              },
            },
          ],
        },
      ],
    });
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
  });
  it.each([
    null,
    {},
    { version: 2, title: 'Sample', turns: [] },
    { ...recording(), execute: 'process.exit()' },
  ])('rejects malformed schema %#', (value) => {
    writeRecording(value);
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
  });
  it('rejects malformed JSON', () => {
    fs.writeFileSync(path.join(home, 'reply.json'), '{');
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
  });
  it('bounds the file read before parsing', () => {
    fs.writeFileSync(path.join(home, 'reply.json'), ' '.repeat(MAX_RECORDING_BYTES + 1));
    expect(() => new ReplaySource(home, 'reply.json')).toThrow('too large');
  });
  it('bounds event counts and strings', () => {
    writeRecording(
      recording(
        Array.from({ length: 1001 }, () => ({ type: 'text_delta', data: { text: 'Sample' } }))
      )
    );
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
    writeRecording(recording([{ type: 'text_delta', data: { text: 'a'.repeat(65_537) } }]));
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
  });
  it.each(['../outside.json', '/outside.json'])('rejects an escaping path %s', (file) => {
    fs.writeFileSync(path.join(sandbox, 'outside.json'), JSON.stringify(recording()));
    expect(() => new ReplaySource(home, file)).toThrow();
  });
  it('rejects symlinked recording paths out of the demo home', () => {
    fs.writeFileSync(path.join(sandbox, 'outside.json'), JSON.stringify(recording()));
    fs.symlinkSync(sandbox, path.join(home, 'linked'));
    expect(() => new ReplaySource(home, 'linked/outside.json')).toThrow('inside the demo');
  });
});

it.each(['replay-connection-access.json', 'replay-codex-chat.json'])(
  'plays the complete made-up capture %s through the runtime',
  async (name) => {
    const fixture = new URL(`../__fixtures__/${name}`, import.meta.url);
    fs.copyFileSync(fixture, path.join(home, 'reply.json'));
    const runtime = new TestModeRuntime(
      name.includes('codex') ? 'codex' : 'claude-code',
      new ReplaySource(home, 'reply.json')
    );
    for (const prompt of ['Show the sample', 'Continue the sample']) {
      const events = await collect(runtime.sendMessage('sample-chat', prompt, { cwd: home }));
      expect(events[0]).toEqual({ type: 'text_delta', data: { text: 'Recorded demo\n\n' } });
      expect(events.at(-1)).toEqual({ type: 'done', data: { sessionId: 'sample-chat' } });
    }
    await expect(collect(runtime.sendMessage('sample-chat', 'Again'))).rejects.toThrow(
      'Recording finished'
    );
    runtime.resetTrackedSessions();
    expect((await collect(runtime.sendMessage('sample-chat', 'Restart')))[0]?.type).toBe(
      'text_delta'
    );
  }
);

describe('a fail-closed marker at every turn', () => {
  it('refuses the real account home and a link to it, even with a marker', () => {
    fs.writeFileSync(path.join(account.productionHome, REPLAY_HOME_MARKER), 'demo');
    vi.stubEnv('DORK_HOME', account.productionHome);
    expect(() => new ReplayHome(account.productionHome)).toThrow('real DorkOS');
    const alias = path.join(sandbox, 'alias');
    fs.symlinkSync(account.productionHome, alias);
    vi.stubEnv('DORK_HOME', alias);
    expect(() => new ReplayHome(alias)).toThrow('real DorkOS');
  });
  it.each(['missing', 'symlinked'])(
    'refuses a %s marker at boot and on the next turn',
    async (kind) => {
      const source = new ReplaySource(home, 'reply.json');
      await collect(source.play('first'));
      fs.unlinkSync(path.join(home, REPLAY_HOME_MARKER));
      if (kind === 'symlinked') {
        const other = path.join(sandbox, 'marker');
        fs.writeFileSync(other, 'demo');
        fs.symlinkSync(other, path.join(home, REPLAY_HOME_MARKER));
      }
      expect(() => new ReplaySource(home, 'reply.json')).toThrow();
      const runtime = new TestModeRuntime('test-mode', source);
      await expect(collect(runtime.sendMessage('second', 'Hello'))).rejects.toThrow();
      expect(await runtime.findSession('second')).toBeNull();
    }
  );
  it('refuses DORK_HOME re-pointed to another marked directory mid-run', async () => {
    const source = new ReplaySource(home, 'reply.json');
    const other = path.join(sandbox, 'another');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, REPLAY_HOME_MARKER), 'demo');
    vi.stubEnv('DORK_HOME', other);
    await expect(collect(source.play('moved'))).rejects.toThrow('folder changed');
  });
  it('refuses a symlinked home re-pointed mid-run', async () => {
    const alias = path.join(sandbox, 'alias');
    fs.symlinkSync(home, alias);
    vi.stubEnv('DORK_HOME', alias);
    const source = new ReplaySource(alias, 'reply.json');
    fs.unlinkSync(alias);
    fs.symlinkSync(account.productionHome, alias);
    await expect(collect(source.play('moved'))).rejects.toThrow();
  });
  it('is unreachable without DORKOS_TEST_RUNTIME, including later turns', async () => {
    const source = new ReplaySource(home, 'reply.json');
    flags.DORKOS_TEST_RUNTIME = false;
    expect(() => new ReplaySource(home, 'reply.json')).toThrow('test runtime');
    await expect(collect(source.play('off'))).rejects.toThrow();
  });
  it('never permits the ordinary scenario path on a replay process', () => {
    expect(() => new TestModeRuntime()).toThrow('needs a recording');
  });
});
