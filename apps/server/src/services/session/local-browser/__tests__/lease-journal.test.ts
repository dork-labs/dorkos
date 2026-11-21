import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { confirmPersonPaint, leaseFixture } from './page-leases-fixture.js';
import { BrowserLeaseJournal } from '../leases/lease-journal.js';
import type { Page } from 'playwright-core';
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

it('every concurrent close waits for the final journal write', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new BrowserLeaseJournal(
    '',
    (work) => work,
    async (record) => {
      if (record.event === 'closed') {
        started();
        await writing;
      }
    }
  );
  await journal.open(
    {
      sessionId: 'chat-a',
      agentId: 'agent-a',
      profileId: 'agent-a',
      connectionId: 'connection-a',
      leaseId: 'lease-a',
    },
    {
      isClosed: () => false,
      url: () => 'about:blank',
      frames: () => [],
    } as unknown as Page
  );
  const first = journal.close();
  let finished = false;
  const second = journal.close().then(() => {
    finished = true;
  });
  await entered;
  await Promise.resolve();
  const finishedBeforeWrite = finished;
  release();
  await Promise.all([first, second]);
  expect(finishedBeforeWrite).toBe(false);
});

it('records page identity and custody without page contents or typed values', async () => {
  const f = await leaseFixture();
  fixtures.push(f);
  const opened = await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://accounts.example.test/private-path?secret=made-up');
  await f.service.personSession('chat-a').handover.takeOver();
  await f.service.personSession('chat-a').handover.resume();
  await f.service.personSession('chat-a').handover.disconnect();
  const contents = await readFile(
    path.join(f.directory, 'local-browser', 'leases.jsonl'),
    'utf8'
  ).catch(() => '');
  const records = contents
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: 'opened',
        sessionId: 'chat-a',
        profileId: 'agent-atlas',
        agentId: 'agent-atlas',
        leaseId: opened.selectedTabId,
      }),
      expect.objectContaining({ event: 'origin', origin: 'https://accounts.example.test' }),
      expect.objectContaining({ event: 'held', actor: 'person' }),
      expect.objectContaining({ event: 'handed-back', actor: 'person' }),
      expect.objectContaining({ event: 'closed' }),
    ])
  );
  for (const privateText of ['private-path', '?secret', 'made-up', 'Page page-'])
    expect(contents).not.toContain(privateText);
});

it('refuses to grant a page when its lifecycle journal cannot persist', async () => {
  const write = vi.fn(async () => {
    throw new Error('Made-up write failure');
  });
  const f = await leaseFixture(write);
  fixtures.push(f);
  await expect(f.open('chat-a')).rejects.toMatchObject({ code: 'audit_unavailable' });
  await expect(f.observe('chat-a')).rejects.toBeDefined();
});

it('records person input by kind without recording its text', async () => {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const viewer = await f.service.pageBroker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'view',
  });
  const control = await f.service.pageBroker.takePersonControl(viewer);
  confirmPersonPaint(control, viewer);
  await control.runPerson({ kind: 'text', text: 'Made-up confidential words' });
  const contents = await readFile(path.join(f.directory, 'local-browser', 'leases.jsonl'), 'utf8');
  const records = contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'person-input',
      actor: 'person',
      input: 'text',
      agentId: 'agent-atlas',
    })
  );
  expect(contents).not.toContain('confidential');
});

it('origin records identify the person while a page is held', async () => {
  const records: unknown[] = [];
  const f = await leaseFixture(async (record) => {
    records.push(record);
  });
  fixtures.push(f);
  await f.open('chat-a');
  await f.service.personSession('chat-a').handover.takeOver();
  f.contexts[0].pages[0].navigate('https://person.example.test/private-step');
  await f.service.personSession('chat-a').handover.resume();
  expect(records).toContainEqual(
    expect.objectContaining({
      event: 'origin',
      actor: 'person',
      origin: 'https://person.example.test',
    })
  );
});
