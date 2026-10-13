import { mkdir, readFile, writeFile, copyFile, unlink, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runBounded } from '../../apps/server/src/services/computers/backend/subprocess.js';
import { userInfo } from 'node:os';
import { createServer } from 'node:net';
import { LimaComputerBackend } from '../../apps/server/src/services/computers/backend/lima-backend.js';
import { qualifyComputerRuntime } from './qualify-runtime.js';

// This attended qualification performs no vendor login or model request.
const workspace = resolve('.workspace');
const marker = randomUUID();
const lock = '/Users/doriancollier/Keep/dork-os/.workspace/shared-local-heavy-producer.lock';
const evidence = join(workspace, 'agent-computer-qualification', marker);
const storageRoot = join('/Users/doriancollier/Keep/dork-os/.workspace/c', marker.slice(0, 8));
const id = randomUUID();
const identity = { id, instanceName: 'computer' };
let generation = 1;
let entered = false;
const backend = new LimaComputerBackend({ storageRoot });

async function progress(step: string, extra: Record<string, unknown> = {}) {
  const record = {
    marker,
    step,
    identity,
    generation,
    storageRoot,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  await writeFile(join(evidence, 'progress.json'), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ step, generation, evidence, ...extra })}\n`);
}
async function guest(argv: string[]) {
  const result = await backend.exec(identity, { argv, timeoutMs: 15_000 });
  if (result.exitCode !== 0)
    throw new Error(`Guest command refused (${result.exitCode}): ${result.stderr.slice(0, 1000)}`);
  return result.stdout;
}
async function admin(argv: string[]): Promise<string> {
  const result = await runBounded(
    join(storageRoot, 'runtime/bin/limactl'),
    ['shell', '--workdir', '/home/lima-admin', identity.instanceName, 'sudo', '-n', '--', ...argv],
    {
      env: {
        PATH: join(storageRoot, 'runtime/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: storageRoot,
        USER: userInfo().username,
        LIMA_HOME: join(storageRoot, 'lima'),
      },
      timeoutMs: 15000,
    }
  );
  if (result.exitCode !== 0) throw new Error('Owned qualification administration failed');
  return result.stdout;
}
async function securityProof() {
  for (const argv of [
    ['/usr/bin/xdotool', 'getdisplaygeometry'],
    ['/usr/bin/openbox', '--reconfigure'],
    ['/usr/bin/test', '-r', '/home/desktop/.Xauthority'],
    ['/usr/bin/test', '-r', '/etc/dorkos-computer/desktop-token'],
    ['/usr/bin/sudo', '-n', '/usr/local/sbin/dorkos-vendor-login'],
  ]) {
    const result = await backend.exec(identity, { argv, timeoutMs: 5000 });
    if (result.exitCode === 0) throw new Error('Guest display or privilege confinement failed');
  }
  const cdp = await guest([
    '/usr/bin/python3',
    '-c',
    "import socket; s=socket.socket(); s.settimeout(2); assert s.connect_ex(('127.0.0.1',9222))!=0; print('Unauthenticated CDP absent')",
  ]);
  const source = await admin([
    '/usr/bin/python3',
    '-c',
    "from pathlib import Path; import stat,json; r=Path('/etc/dorkos-computer'); token=(r/'desktop-token').read_bytes(); roots=[Path('/var/lib/cloud'),Path('/mnt/lima-cidata')]; readable=[]; leaks=[];\nfor root in roots:\n for p in root.rglob('*'):\n  if p.is_file():\n   try:\n    if token in p.read_bytes(): leaks.append(str(p))\n   except OSError:pass\nassert not leaks; print(json.dumps({'secretSources':leaks,'desktopCookieMode':oct(Path('/home/desktop/.Xauthority').stat().st_mode&0o777),'openboxConfigUid':Path('/etc/dorkos-desktop/rc.xml').stat().st_uid}))",
  ]);
  await writeFile(join(evidence, 'display-security.json'), JSON.stringify({ cdp, source }), {
    mode: 0o600,
  });
  await progress('display-and-provision-secrets-confinement-observed');
}
async function desktop(path: string, body?: unknown) {
  const endpoints = await backend.endpoints(identity);
  const response = await fetch(new URL(path, endpoints.desktopUrl), {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${endpoints.desktopPassword}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Desktop ${path} refused (${response.status})`);
  return response.json() as Promise<Record<string, unknown>>;
}
async function waitReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      await desktop('/health');
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  throw new Error('Guest desktop did not become ready');
}
async function frame(name: string) {
  const image = await desktop('/frame');
  if (typeof image.dataUrl !== 'string' || !image.dataUrl.startsWith('data:image/png;base64,'))
    throw new Error('No PNG frame');
  const png = Buffer.from(image.dataUrl.split(',')[1], 'base64');
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Invalid frame bytes');
  await writeFile(join(evidence, name), png, { mode: 0o600 });
}
async function networkProof() {
  const probe = createServer((socket) => {
    socket.end('host probe');
  });
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  try {
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('No probe port');
    const source = `import socket,json\nresults={}\nfor host,port in [('192.168.5.2',${address.port}),('10.0.0.1',80),('169.254.169.254',80)]:\n s=socket.socket();s.settimeout(2)\n try:s.connect((host,port));results[host]='reachable'\n except OSError as e:results[host]=str(e)\n finally:s.close()\nprint(json.dumps(results))\nassert all(v!='reachable' for v in results.values())`;
    const output = await guest(['/usr/bin/python3', '-c', source]);
    await writeFile(join(evidence, 'network.json'), output, { mode: 0o600 });
  } finally {
    await new Promise<void>((done) => probe.close(() => done()));
  }
  const privilege = await backend.exec(identity, {
    argv: ['/usr/bin/sudo', '-n', 'true'],
    timeoutMs: 5000,
  });
  if (privilege.exitCode === 0) throw new Error('Guest agent unexpectedly has sudo');
  await progress('network-and-privilege-denial-observed');
}

async function qualify() {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Shared heavy producer already occupied', { cause: error });
    throw error;
  }
  entered = true;
  await writeFile(
    join(lock, 'owner.json'),
    JSON.stringify({
      marker,
      owner: 'agent-computer-mvp',
      pid: process.pid,
      evidence,
      operation: 'bounded-non-inference-vz-qualification',
      acquiredAt: new Date().toISOString(),
    }),
    { flag: 'wx', mode: 0o600 }
  );
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  for (const [cached, target] of [
    ['debian.qcow2', 'linux.qcow2'],
    ['lima.tar.gz', 'lima.tar.gz'],
  ]) {
    try {
      await copyFile(
        join(workspace, 'computer-backend-artifacts', cached),
        join(storageRoot, target)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await progress('owned-lock-acquired-create-intent');
  const created = await backend.create(identity, generation);
  await progress('create-observed', { observation: created });
  if (created.phase !== 'running') throw new Error('VM create did not prove running');
  await waitReady();
  await frame('first-frame.png');
  await guest([
    '/usr/bin/python3',
    '-c',
    "from pathlib import Path; Path('/home/agent/project/qualification.txt').write_text('persistent computer proof'); print('file and profile written')",
  ]);
  await admin([
    '/usr/bin/python3',
    '-c',
    "from pathlib import Path; Path('/home/desktop/.config/chromium/qualification.txt').write_text('persistent profile proof')",
  ]);
  await securityProof();
  const leaseId = randomUUID();
  await desktop('/control', { held: true, leaseId, generation });
  await desktop('/input', { kind: 'pointer', action: 'move', x: 400, y: 300, leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'down', key: 'Control', leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'down', key: 'l', leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'up', key: 'l', leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'up', key: 'Control', leaseId, generation });
  await desktop('/input', { kind: 'text', text: 'https://example.com', leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'down', key: 'Enter', leaseId, generation });
  await desktop('/input', { kind: 'key', action: 'up', key: 'Enter', leaseId, generation });
  await new Promise((done) => setTimeout(done, 1500));
  await frame('person-browser-frame.png');
  await desktop('/control', { held: false, leaseId, generation });
  const expiringLease = randomUUID();
  await desktop('/control', { held: true, leaseId: expiringLease, generation });
  await desktop('/input', {
    kind: 'key',
    action: 'down',
    key: 'Control',
    leaseId: expiringLease,
    generation,
  });
  await progress('guest-control-expiry-wait');
  await new Promise((done) => setTimeout(done, 32_000));
  const endpoints = await backend.endpoints(identity);
  const stale = await fetch(new URL('/input', endpoints.desktopUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${endpoints.desktopPassword}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'key',
      action: 'up',
      key: 'Control',
      leaseId: expiringLease,
      generation,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (stale.status !== 409) throw new Error('Expired guest lease accepted input');
  const frozen = await admin([
    '/usr/bin/systemctl',
    'show',
    'dorkos-opencode.service',
    '--property=FreezerState',
    '--value',
  ]);
  if (frozen.trim() !== 'running') throw new Error('Expired guest lease left runtime frozen');
  await progress('guest-control-expiry-and-thaw-observed');
  await networkProof();
  const runtimeProof = async (phase: 'seed' | 'resume') =>
    qualifyComputerRuntime({
      anchor: join(evidence, 'runtime-anchor'),
      evidenceDirectory: evidence,
      phase,
      onProgress: (step) => progress('runtime-' + step),
      ensureEndpoint: async () => {
        const observation = await backend.status(identity);
        if (observation.phase !== 'running')
          throw new Error('Runtime qualification guest is not running');
        return { ...(await backend.endpoints(identity)), generation: observation.generation };
      },
    });
  await runtimeProof('seed');
  const stopped = await backend.stop(identity, ++generation);
  if (stopped.phase !== 'stopped') throw new Error('Stop uncertain');
  await progress('stop-observed', { observation: stopped });
  const restarted = new LimaComputerBackend({ storageRoot });
  const running = await restarted.start(identity, ++generation);
  if (running.phase !== 'running') throw new Error('Restart uncertain');
  await waitReady();
  await runtimeProof('resume');
  const retained = await guest([
    '/usr/bin/python3',
    '-c',
    "from pathlib import Path; assert Path('/home/agent/project/qualification.txt').read_text()=='persistent computer proof'; print('file and profile persisted across backend restart')",
  ]);
  await admin([
    '/usr/bin/python3',
    '-c',
    "from pathlib import Path; assert Path('/home/desktop/.config/chromium/qualification.txt').read_text()=='persistent profile proof'",
  ]);
  await writeFile(join(evidence, 'persistence.txt'), retained, { mode: 0o600 });
  await frame('restarted-frame.png');
  await progress('non-inference-qualification-passed');
}

try {
  await qualify();
} catch (error) {
  if (entered)
    await progress('qualification-failed', {
      error: error instanceof Error ? error.message : 'Unknown failure',
    });
  else process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (entered) {
    let safeReturn = false;
    try {
      let observation = await backend.status(identity);
      if (observation.phase === 'running') observation = await backend.stop(identity, ++generation);
      safeReturn = observation.phase === 'stopped' || observation.phase === 'missing';
      await progress('final-resource-observation', { observation });
    } catch (error) {
      await progress('physical-return-uncertain', { error: String(error) });
    }
    if (safeReturn) {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')) as {
        marker: string;
      };
      if (owner.marker !== marker) {
        process.exitCode = 1;
        await progress('foreign-lock-marker-retained');
      } else {
        await writeFile(
          join(evidence, 'return.json'),
          JSON.stringify({
            marker,
            physicalReturnQualified: true,
            nextEntryAuthorized: false,
            retainedStorage: storageRoot,
            returnedAt: new Date().toISOString(),
          }),
          { mode: 0o600 }
        );
        await unlink(join(lock, 'owner.json'));
        await rmdir(lock);
        await progress('owned-lock-released-data-retained');
      }
    } else {
      process.exitCode = 1;
      await progress('owned-lock-retained-physical-stop-uncertain');
    }
  }
}
