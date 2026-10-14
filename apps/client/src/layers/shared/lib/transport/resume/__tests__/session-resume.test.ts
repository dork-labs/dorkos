/**
 * A reopened chat's stream resumes from its last cursor (DOR-2913).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamConnectionOptions } from '../../ws-connection';
import {
  forgetSessionResume,
  resetSessionResume,
  resumableConnections,
  setSessionResumePolicy,
} from '../session-resume';

const URL_A = '/api/sessions/chat-a/events?cwd=%2Fwork';

/** A fake connection whose cursor the test sets, recording what it was built with. */
function fakeFactory() {
  const built: {
    url: string;
    options: StreamConnectionOptions;
    setCursor: (id: string) => void;
  }[] = [];
  const create = vi.fn((url: string, options: StreamConnectionOptions) => {
    let cursor: string | null = options.resumeFrom ?? null;
    built.push({ url, options, setCursor: (id) => (cursor = id) });
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn(),
      getLastEventId: () => cursor,
    };
  });
  return { create, built, factory: resumableConnections(create) };
}

const OPTIONS: StreamConnectionOptions = { eventHandlers: {} };

beforeEach(() => resetSessionResume());

describe('resumableConnections', () => {
  it('resumes a chat stream from where its last connection left off', () => {
    const onResume = vi.fn();
    setSessionResumePolicy({ canResume: () => true, onResume });
    const { built, factory } = fakeFactory();

    const first = factory(URL_A, OPTIONS);
    expect(built[0]!.options.resumeFrom).toBeUndefined();
    built[0]!.setCursor('chat-a-1-gen-42');
    first.destroy();

    factory(URL_A, OPTIONS);
    expect(built[1]!.options.resumeFrom).toBe('chat-a-1-gen-42');
    expect(onResume).toHaveBeenCalledWith('chat-a');
  });

  it('takes a snapshot when the app no longer holds the chat', () => {
    const onResume = vi.fn();
    setSessionResumePolicy({ canResume: () => false, onResume });
    const { built, factory } = fakeFactory();
    const first = factory(URL_A, OPTIONS);
    built[0]!.setCursor('chat-a-1-gen-42');
    first.destroy();
    factory(URL_A, OPTIONS);
    expect(built[1]!.options.resumeFrom).toBeUndefined();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('keeps cursors per directory, and forgets a removed chat', () => {
    setSessionResumePolicy({ canResume: () => true, onResume: () => {} });
    const { built, factory } = fakeFactory();
    const first = factory(URL_A, OPTIONS);
    built[0]!.setCursor('chat-a-1-gen-42');
    first.disconnect();

    factory('/api/sessions/chat-a/events?cwd=%2Felsewhere', OPTIONS);
    expect(built[1]!.options.resumeFrom).toBeUndefined();

    forgetSessionResume('chat-a');
    factory(URL_A, OPTIONS);
    expect(built[2]!.options.resumeFrom).toBeUndefined();
  });

  it('leaves every other stream alone', () => {
    setSessionResumePolicy({ canResume: () => true, onResume: () => {} });
    const { create, factory } = fakeFactory();
    const list = { eventHandlers: {} };
    factory('/api/events', list);
    expect(create).toHaveBeenCalledWith('/api/events', list);
  });
});
