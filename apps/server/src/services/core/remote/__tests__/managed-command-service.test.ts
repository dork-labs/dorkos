/**
 * When the managed remote access command stream runs (DOR-2086): dormant
 * unless every condition holds, a boot that reconnects and opens nothing, a
 * command reaching the dispatcher and its acknowledgement going out, and a
 * stop that ends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import openFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-open.json' with { type: 'json' };

import { CommandDispatcher } from '../command-dispatcher.js';
import type { AvailabilitySnapshot } from '../managed-availability.js';
import { ManagedCommandService } from '../managed-command-service.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';
import { commandWorld, INSTANCE_ID, type CommandWorld } from './command-harness.js';

const ACK = '/v1/remote/commands/ack';

let w: CommandWorld;

beforeEach(async () => {
  w = await commandWorld();
});

afterEach(() => {
  w.cleanup();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await tick();
  expect(check()).toBe(true);
}

/** A stream that stays open until the test pushes into it or it is aborted. */
function sseStream() {
  const opened: Array<{ push: (text: string) => void; end: () => void; signal: AbortSignal }> = [];
  const openStream = vi.fn(async (_context: unknown, signal: AbortSignal) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    opened.push({
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      end: () => controller.close(),
      signal,
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  return { opened, openStream };
}

function service(
  options: {
    flag?: boolean;
    availability?: AvailabilitySnapshot['availability'];
    canExpose?: boolean;
    attach?: boolean;
  } = {}
) {
  const { opened, openStream } = sseStream();
  const svc = new ManagedCommandService({
    availability: {
      enabled: options.flag ?? true,
      read: async () => ({
        availability: options.availability ?? 'available',
        instanceId: INSTANCE_ID,
        cloudStatus: null,
        cloudStale: false,
      }),
      markAbsent: vi.fn(),
    },
    captureContext: w.cloud.capture,
    readRemoteState,
    canExpose: () => options.canExpose ?? true,
    dispatcher: (journal, onSettled) =>
      new CommandDispatcher({
        journal,
        tunnelManager: w.tunnel,
        remoteCredentials: w.credentials,
        readRemoteState,
        updateRemoteState,
        onSettled,
      }),
    openStream,
    stream: { sleep: async () => undefined, random: () => 0.5 },
  });
  if (options.attach ?? true) svc.attach(w.db);
  return { svc, opened, openStream };
}

describe('ManagedCommandService', () => {
  it('stays dormant unless every condition holds', async () => {
    expect(await service({ flag: false }).svc.start()).toBe(false);
    expect(await service({ availability: 'hidden' }).svc.start()).toBe(false);
    expect(await service({ availability: 'unavailable' }).svc.start()).toBe(false);
    expect(await service({ canExpose: false }).svc.start()).toBe(false);

    expect(await service({ attach: false }).svc.start()).toBe(false);

    updateRemoteState('test', { credentialId: null, credentialRef: null, edgeProofRef: null });
    const noCredential = service();
    expect(await noCredential.svc.start()).toBe(false);
    expect(noCredential.openStream).not.toHaveBeenCalled();
  });

  it('stays dormant when not enrolled, or enrolled under another link', async () => {
    updateRemoteState('test', { instanceId: 'inst_other' });
    expect(await service().svc.start()).toBe(false);
    w.cloud.unlink();
    expect(await service().svc.start()).toBe(false);
  });

  it('on boot reconnects the stream and opens nothing', async () => {
    const { svc, opened, openStream } = service({ attach: false });
    svc.boot(w.db);
    await until(() => opened.length === 1);
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
    svc.stop();
  });

  it('hands a command to the dispatcher and acknowledges it', async () => {
    w.cloud.on('POST', ACK, { status: 200, body: { acknowledged: 1 } });
    const { svc, opened } = service();
    expect(await svc.start()).toBe(true);
    await until(() => opened.length === 1);
    opened[0]!.push(`data: ${JSON.stringify(openFixture)}\n\n`);
    await until(() => w.cloud.callsTo('POST', ACK).length === 1);
    expect(w.tunnel.startManaged).toHaveBeenCalledTimes(1);
    expect(w.journal.read([openFixture.id])[0]?.ackState).toBe('acked');
    svc.stop();
  });

  it('stops at once, and stops by itself when the enrolment goes', async () => {
    const { svc, opened } = service();
    await svc.start();
    await until(() => opened.length === 1);
    svc.stop();
    expect(svc.running).toBe(false);
    expect(opened[0]!.signal.aborted).toBe(true);

    const second = service();
    await second.svc.start();
    await until(() => second.opened.length === 1);
    updateRemoteState('test withdrawal', {
      mode: 'off',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
    });
    // The next reconnect asks whether it still belongs, and it does not.
    second.opened[0]!.end();
    await until(() => !second.svc.running);
    expect(second.opened).toHaveLength(1);
  });

  it('a stop while starting opens nothing', async () => {
    const { svc, openStream } = service();
    const starting = svc.start();
    svc.stop();
    expect(await starting).toBe(false);
    expect(openStream).not.toHaveBeenCalled();
  });
});
