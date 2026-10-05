import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRestriction,
  deriveOmittedWebRtcFlag,
  ownWebRtcEndpoints,
  ownWebRtcPreflight,
  readOwnedBytes,
  type IceObservation,
} from './webrtc-acceptance-endpoints.js';
const exercised: IceObservation = {
  api: true,
  dataChannel: true,
  localDescription: true,
  candidates: 0,
  gatheringComplete: true,
  elapsed: 25,
};
describe('native endpoint WebRTC restriction oracle', () => {
  it('requires real positive calibration beside exercised restricted zero', () => {
    expect(
      classifyRestriction({
        restricted: exercised,
        calibration: exercised,
        restrictedPackets: 0,
        calibrationPackets: 2,
      })
    ).toBe('observed');
    expect(
      classifyRestriction({
        restricted: exercised,
        calibration: exercised,
        restrictedPackets: 0,
        calibrationPackets: 0,
      })
    ).toBe('unverified');
  });
  it('reports native endpoint traffic as bypass instead of accepting a successful ICE API call', () => {
    expect(
      classifyRestriction({
        restricted: exercised,
        calibration: exercised,
        restrictedPackets: 1,
        calibrationPackets: 2,
      })
    ).toBe('bypass');
  });
  it.each(['api', 'dataChannel', 'localDescription'] as const)(
    'refuses missing actual %s invocation on either cohort',
    (field) => {
      for (const missing of ['restricted', 'calibration'] as const) {
        const rows = { restricted: exercised, calibration: exercised };
        rows[missing] = { ...exercised, [field]: false };
        expect(classifyRestriction({ ...rows, restrictedPackets: 0, calibrationPackets: 2 })).toBe(
          'unverified'
        );
      }
    }
  );
});

describe('owned Node endpoint and preflight custody', () => {
  it('owns HTTP and TCP sockets and observes UDP, both listeners and original sockets closing', async () => {
    const endpoints = ownWebRtcEndpoints();
    const addresses = await endpoints.listen();
    const clients: Socket[] = [];
    try {
      for (const port of [addresses.tcpPort, addresses.originPort]) {
        const client = connect(port, '127.0.0.1');
        clients.push(client);
        await once(client, 'connect');
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(endpoints.snapshot().sockets).toBe(2);
      await endpoints.close();
      expect(endpoints.snapshot()).toMatchObject({
        sockets: 0,
        udpClosed: true,
        tcpClosed: true,
        originClosed: true,
        uncertain: false,
      });
    } finally {
      for (const client of clients) client.destroy();
      await endpoints.close();
    }
  });

  it('attempts the other originals when an actual delivered socket destroy throws undefined', async () => {
    const endpoints = ownWebRtcEndpoints();
    const addresses = await endpoints.listen();
    const delivered = once(endpoints.tcp, 'connection');
    const client = connect(addresses.tcpPort, '127.0.0.1');
    await once(client, 'connect');
    const [original] = (await delivered) as [Socket];
    const destroy = original.destroy;
    original.destroy = () => {
      original.destroy = destroy; // Fault the explicit attempt only, not later Node internal teardown.
      throw undefined;
    };
    let present = false,
      first: unknown;
    const close = endpoints.close().catch((error) => {
      present = true;
      first = error;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(endpoints.snapshot()).toMatchObject({
        sockets: 1,
        udpClosed: true,
        originClosed: true,
        uncertain: true,
      });
    } finally {
      original.destroy = destroy;
      Reflect.apply(destroy, original, []);
      client.destroy();
      await close;
    }
    expect(present).toBe(true);
    expect(first).toBeUndefined();
    expect(endpoints.snapshot()).toMatchObject({ sockets: 0, tcpClosed: true, uncertain: true });
  });

  it('retains the delivered over-cap socket until actual close and stops both listeners', async () => {
    const endpoints = ownWebRtcEndpoints();
    const addresses = await endpoints.listen();
    const clients: Socket[] = [];
    let overflowOwnedBeforeClose = false;
    endpoints.origin.on('connection', () => {
      if (endpoints.snapshot().uncertain)
        overflowOwnedBeforeClose = endpoints.snapshot().sockets === 17;
    });
    try {
      for (let index = 0; index < 16; index++) {
        const delivered = once(index < 8 ? endpoints.tcp : endpoints.origin, 'connection');
        const client = connect(index < 8 ? addresses.tcpPort : addresses.originPort, '127.0.0.1');
        clients.push(client);
        await once(client, 'connect');
        await delivered;
      }
      const delivered = once(endpoints.origin, 'connection');
      const overflow = connect(addresses.originPort, '127.0.0.1');
      clients.push(overflow);
      await once(overflow, 'connect');
      await delivered;
      expect(overflowOwnedBeforeClose).toBe(true);
      await expect(endpoints.close()).rejects.toThrow('FIXTURE_ENDPOINT_CAP');
      expect(endpoints.snapshot()).toMatchObject({
        sockets: 0,
        udpClosed: true,
        tcpClosed: true,
        originClosed: true,
        uncertain: true,
      });
    } finally {
      for (const client of clients) client.destroy();
      await endpoints.close().catch(() => {});
    }
  });

  it('retains a real late-created named home without healing an expired acquisition', async () => {
    const owner = ownWebRtcPreflight();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let named: string | undefined;
    const native = async () => {
      named = await mkdtemp(join(tmpdir(), 'webrtc-late-home-control-'));
      await gate;
      return named;
    };
    await expect(owner.acquireHome(native, 10)).rejects.toThrow('FIXTURE_ACQUISITION_EXPIRED');
    expect((await owner.finish(10)).observed).toBe(false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(owner.homes()).toEqual([named]);
    expect((await owner.finish(100)).observed).toBe(false);
    // This control owns only a known directory; no engine/endpoint work or late producer remains.
    await rm(named!, { recursive: true });
    const healthy = ownWebRtcPreflight();
    const home = await healthy.acquireHome(() => mkdtemp(join(tmpdir(), 'webrtc-home-control-')));
    expect((await healthy.finish()).observed).toBe(true);
    await healthy.removeHome(home);
    expect(healthy.removalSnapshot()).toEqual({ started: true, returned: true, held: false });
  });
});

it('derives exactly one flag removal from an exact frozen compiler-emitted file manifest', async () => {
  const home = await mkdtemp(join(tmpdir(), 'webrtc-derivation-control-'));
  try {
    const dist = join(home, 'dist');
    await mkdir(join(dist, 'runtime'), { recursive: true });
    const literal = "'--webrtc-ip-handling-policy=disable_non_proxied_udp',";
    const policy = join(home, 'policy.ts');
    await writeFile(policy, literal);
    await writeFile(
      join(dist, 'runtime/darwin-supervisor-browser.js'),
      `const args=[${literal}'--unchanged'];`
    );
    await writeFile(join(dist, 'runtime/darwin-supervisor-worker.js'), 'unchanged worker');
    const paths = ['runtime/darwin-supervisor-browser.js', 'runtime/darwin-supervisor-worker.js'];
    const receipt = paths.map((path) => `TSFILE: ${dist}/${path}`).join('\n') + '\n';
    const manifest = join(home, 'emitted.json');
    await writeFile(manifest + '.stdout', receipt);
    await writeFile(
      manifest,
      JSON.stringify({
        kind: 'owned-tsc-emitted-files-v1',
        compilerExit: 0,
        receiptSHA256: createHash('sha256').update(receipt).digest('hex'),
        files: await Promise.all(
          paths.map(async (path) => ({
            path,
            mode: 0o644,
            sha256: createHash('sha256')
              .update(await readFile(join(dist, path)))
              .digest('hex'),
          }))
        ),
      })
    );
    const result = await deriveOmittedWebRtcFlag(dist, join(home, 'derived'), policy, manifest);
    expect(result.rows.filter((row) => row.beforeSHA256 !== row.afterSHA256)).toHaveLength(1);
    expect(await readFile(join(home, 'derived/runtime/darwin-supervisor-browser.js'), 'utf8')).toBe(
      "const args=['--unchanged'];"
    );
    expect(await readFile(result.workerPath, 'utf8')).toBe('unchanged worker');
  } finally {
    await rm(home, { recursive: true });
  }
});

it('retains a held original real directory removal and never retries or heals its late return', async () => {
  const owner = ownWebRtcPreflight();
  const home = await owner.acquireHome(() =>
    mkdtemp(join(tmpdir(), 'webrtc-held-removal-control-'))
  );
  expect((await owner.finish()).observed).toBe(true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const remove = async (named: string) => {
    entered++;
    await gate;
    await rm(named, { recursive: true }); // Real filesystem effect belongs to this one original producer.
  };
  const pending = owner.removeHome(home, 10, remove);
  try {
    await expect(pending).rejects.toThrow('FIXTURE_HOME_REMOVAL_EXPIRED');
    expect(owner.removalSnapshot()).toEqual({ started: true, returned: false, held: true });
    expect(owner.homes()).toEqual([home]);
  } finally {
    release();
  }
  // The raw original is independently retained; observe its actual late filesystem return.
  for (let attempt = 0; attempt < 100 && !owner.removalSnapshot().returned; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(owner.removalSnapshot()).toEqual({ started: true, returned: true, held: true });
  expect(owner.removeHome(home, 10, remove)).toBe(pending);
  await expect(pending).rejects.toThrow('FIXTURE_HOME_REMOVAL_EXPIRED');
  expect(entered).toBe(1);
  expect((await owner.finish()).observed).toBe(false);
});

it('reads an exact empty or capped original file and refuses an oversized input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'webrtc-sized-read-control-'));
  try {
    const file = join(home, 'input');
    await writeFile(file, '');
    expect(await readOwnedBytes(file, 0)).toEqual(Buffer.alloc(0));
    await writeFile(file, 'exact');
    expect((await readOwnedBytes(file, 5)).toString()).toBe('exact');
    await expect(readOwnedBytes(file, 4)).rejects.toThrow('FIXTURE_INPUT_INVALID');
  } finally {
    await rm(home, { recursive: true });
  }
});
