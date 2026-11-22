import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wrapKickoff } from '@dorkos/shared/kickoff';
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
    expect(chat.read().title).toBe('');
    expect(chat.read().lastMessagePreview).toBe('');

    chat.record('Fix the build');
    expect(chat.read().title).toBe('Fix the build');
    expect(chat.read().lastMessagePreview).toBe('Fix the build');
  });
});

describe('Doe: a chat that opens with the greeting kickoff', () => {
  it('shows no tag, and takes its title from the person’s first message', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-kickoff-'));
    const store = new DoeSessionStore(directory);
    try {
      store.ensure(SESSION, { cwd: CWD });
      store.message(SESSION, KICKOFF, CWD);
      expect(store.get(SESSION)?.session.title ?? '').toBe('');
      expect(store.get(SESSION)?.session.lastMessagePreview).toBe('');

      store.message(SESSION, 'Fix the build', CWD);
      expect(store.get(SESSION)?.session.title).toBe('Fix the build');
      expect(store.get(SESSION)?.session.lastMessagePreview).toBe('Fix the build');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
