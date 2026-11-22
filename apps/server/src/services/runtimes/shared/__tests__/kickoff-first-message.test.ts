import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapKickoff } from '@dorkos/shared/kickoff';
import type { Session } from '@dorkos/shared/types';
import { expectNoDorkMarkup } from './no-dork-markup.js';
import { CodexSessionRegistry } from '../../codex/session-registry.js';
import { OpenCodeSessionRegistry } from '../../opencode/sessions/session-registry.js';
import { TestModeSessionRegistry } from '../../test-mode/session-registry.js';
import { DoeSessionStore } from '../../doe/session-store.js';

// A new agent's first chat opens with DorkOS's greeting kickoff (DOR-4976).
// Every runtime that titles a chat from its first message must show neither
// the kickoff's tag as the title nor as the preview, and the person's own
// first message must still name the chat.
const KICKOFF = wrapKickoff('Read your SOUL.md and say hello.');
const SESSION = 'chat-1';
const CWD = '/projects/demo';

type Recorder = {
  record: (content: string) => void;
  read: () => { title: string; lastMessagePreview?: string };
};

const registries: Array<[string, () => Recorder]> = [
  [
    'Codex',
    () => {
      const registry = new CodexSessionRegistry();
      return {
        record: (content) => registry.recordMessage(SESSION, content, { cwd: CWD }),
        read: () => registry.get(SESSION)!,
      };
    },
  ],
  [
    'OpenCode',
    () => {
      const registry = new OpenCodeSessionRegistry();
      return {
        record: (content) => registry.recordMessage(SESSION, content, { cwd: CWD }),
        read: () => registry.get(SESSION)!,
      };
    },
  ],
  [
    'test mode',
    () => {
      const registry = new TestModeSessionRegistry();
      return {
        record: (content) => registry.recordMessage(SESSION, content, { cwd: CWD }),
        read: () => registry.get(SESSION)!,
      };
    },
  ],
];

describe.each(registries)('%s: a chat that opens with the greeting kickoff', (_name, make) => {
  it('shows no tag, and takes its title from the person’s first message', () => {
    const chat = make();
    chat.record(KICKOFF);
    expectNoDorkMarkup(chat.read());
    expect(chat.read().title).toBe('');
    expect(chat.read().lastMessagePreview).toBe('');

    chat.record('Fix the build');
    expect(chat.read().title).toBe('Fix the build');
    expect(chat.read().lastMessagePreview).toBe('Fix the build');
  });
});

/** A chat stored before DOR-4976, titled from its greeting kickoff. */
const STUCK: Session = {
  id: SESSION,
  title: '<dork-kickoff>',
  lastMessagePreview: '<dork-kickoff>',
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  permissionMode: 'default',
  runtime: 'codex',
  cwd: CWD,
};

describe('Codex: a chat stored with a kickoff title before the fix', () => {
  it('shows as untitled, and the person’s next message names it', () => {
    const registry = new CodexSessionRegistry();
    registry.hydrate([STUCK]);
    expectNoDorkMarkup(registry.get(SESSION));
    expect(registry.list(CWD).map((session) => session.title)).toEqual(['']);

    registry.recordMessage(SESSION, 'Fix the build');
    expect(registry.get(SESSION)?.title).toBe('Fix the build');
  });

  it('cleans a natively adopted chat too', () => {
    const registry = new CodexSessionRegistry();
    registry.adoptNative(STUCK);
    expectNoDorkMarkup(registry.get(SESSION));
  });
});

describe('Doe: a chat that opens with the greeting kickoff', () => {
  const withStore = (run: (store: DoeSessionStore) => void) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-kickoff-'));
    const store = new DoeSessionStore(directory);
    try {
      run(store);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  it('shows no tag, and takes its title from the person’s first message', () =>
    withStore((store) => {
      store.ensure(SESSION, { cwd: CWD });
      store.message(SESSION, KICKOFF, CWD);
      expectNoDorkMarkup(store.get(SESSION)?.session);
      expect(store.get(SESSION)?.session.title ?? '').toBe('');
      expect(store.get(SESSION)?.session.lastMessagePreview).toBe('');

      store.message(SESSION, 'Fix the build', CWD);
      expect(store.get(SESSION)?.session.title).toBe('Fix the build');
      expect(store.get(SESSION)?.session.lastMessagePreview).toBe('Fix the build');
    }));

  it('shows a chat stored with a kickoff title before the fix as untitled', () =>
    withStore((store) => {
      const record = store.ensure(SESSION, { cwd: CWD });
      store.save({ ...record, session: { ...record.session, ...STUCK, runtime: 'doe' } });
      expectNoDorkMarkup(store.get(SESSION)?.session);
      for (const session of store.list(CWD)) expectNoDorkMarkup(session);

      store.message(SESSION, 'Fix the build', CWD);
      expect(store.get(SESSION)?.session.title).toBe('Fix the build');
    }));
});
