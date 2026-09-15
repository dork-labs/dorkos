/**
 * `config_changed` says WHICH settings moved, and never what they say.
 *
 * ## The reason this is a test and not a comment
 *
 * Config holds credentials — a tunnel authtoken, an MCP API key, provider keys.
 * The event exists so that a sidebar section created in one window appears in
 * the other, and the client answers it with a refetch of `GET /api/config`,
 * which is already gated. So the payload needs nothing but the section names,
 * and the day it carries a value instead, nothing about the feature will look
 * broken: it will work exactly as well, while writing secrets to every reader on
 * a bus that also serves the phone over a public tunnel.
 *
 * ## What this file adds over its unit-test sibling
 *
 * `live-change-broadcasts.test.ts` drives the wiring with fakes and probes the
 * decisions. This one drives the REAL `ConfigManager` — a real file on disk, a
 * real `set`, a real dotted-path `setDot` — through the REAL
 * {@link wireLiveChangeBroadcasts} into the REAL `eventFanOut`, with real
 * clients attached. So it answers the question the fakes cannot: does a
 * genuine settings write, of a genuine secret, actually put nothing but section
 * names on the socket.
 *
 * Neither file copies the wiring any more. The first version of this one did,
 * and adversarial review measured what that was worth: deleting
 * `operatorAudience` from `index.ts` left it green.
 *
 * ## And it is addressed, not broadcast
 *
 * Settings are a person's surface. An agent holding an `/api/events` connection
 * has no business learning that somebody rearranged their sidebar, so the
 * wiring passes `operatorAudience` — the same gate `notification` uses. Proven
 * here with connected clients of each kind.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigManager } from '../config-manager.js';
import { eventFanOut, type EncodedBroadcast, type FanOutClient } from '../event-fan-out.js';
import { wireLiveChangeBroadcasts } from '../streams/live-change-broadcasts.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';

/** A connected reader that just keeps what it was sent. */
class RecordingClient implements FanOutClient {
  readonly received: EncodedBroadcast[] = [];
  readonly bufferedBytes = 0;
  readonly gone = false;
  send(broadcast: EncodedBroadcast): void {
    this.received.push(broadcast);
  }
  drop(): void {}
}

const tempDirs: string[] = [];
let manager: ConfigManager;
let detach: Array<() => void>;

/** Attach a client as `principal` and get back what it receives. */
function connect(principal: CallerPrincipal): RecordingClient {
  const client = new RecordingClient();
  detach.push(eventFanOut.addClient(client, principal));
  return client;
}

/** Every `config_changed` payload a client was sent, parsed back off the wire. */
function payloads(client: RecordingClient): Array<Record<string, unknown>> {
  return client.received
    .filter((b) => b.event === 'config_changed')
    .map((b) => JSON.parse(b.json).data as Record<string, unknown>);
}

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-changed-'));
  tempDirs.push(dir);
  manager = new ConfigManager(dir);
  detach = [];

  // The REAL wiring, the same call `index.ts` makes. No mesh: this file is
  // about settings, and `wireLiveChangeBroadcasts` takes `undefined` there for
  // the server-without-mesh case it already has to support.
  wireLiveChangeBroadcasts({ meshCore: undefined, configManager: manager, eventFanOut });
});

afterEach(async () => {
  for (const off of detach.splice(0)) off();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('config_changed', () => {
  it('carries the section names and a timestamp, and nothing else', () => {
    const operator = connect({ kind: 'operator' });

    manager.set('tunnel', { ...manager.get('tunnel'), authtoken: 'sk-do-not-broadcast-me' });

    expect(payloads(operator)).toHaveLength(1);
    const [payload] = payloads(operator);
    expect(Object.keys(payload).sort()).toEqual(['changedAt', 'sections']);
    expect(payload.sections).toEqual(['tunnel']);
    expect(typeof payload.changedAt).toBe('string');
  });

  it('no value from the config reaches the wire — the secret one included', () => {
    const operator = connect({ kind: 'operator' });

    manager.set('tunnel', { ...manager.get('tunnel'), authtoken: 'sk-do-not-broadcast-me' });
    manager.setDot('profile.displayName', 'A Name Nobody On The Stream Should Read');

    // The whole frame, both encodings, across every broadcast this made.
    const wire = operator.received.map((b) => `${b.json}\n${b.sse}`).join('\n');
    expect(wire).not.toContain('sk-do-not-broadcast-me');
    expect(wire).not.toContain('A Name Nobody On The Stream Should Read');
    // …and it really did write them, so the absence above is the payload's
    // shape and not a write that never happened.
    expect(manager.get('tunnel').authtoken).toBe('sk-do-not-broadcast-me');
    expect(manager.getAll().profile.displayName).toBe('A Name Nobody On The Stream Should Read');
  });

  it('a dotted-path write reports its top-level section', () => {
    const operator = connect({ kind: 'operator' });

    manager.setDot('runtimes.default', 'codex');

    expect(payloads(operator)).toEqual([expect.objectContaining({ sections: ['runtimes'] })]);
  });

  it('reaches a person and a program, never an agent', () => {
    const operator = connect({ kind: 'operator' });
    const program = connect({ kind: 'program', userId: 'user-1' });
    const agent = connect({ kind: 'agent' });

    manager.setDot('runtimes.default', 'codex');

    expect(payloads(operator)).toHaveLength(1);
    expect(payloads(program)).toHaveLength(1);
    expect(payloads(agent)).toHaveLength(0);
  });
});
