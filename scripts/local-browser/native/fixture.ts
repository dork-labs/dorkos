/** Shared native fixture. Importing this module opens no server and writes no files. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { bounded } from '../owned-chrome-cleanup.js';
export type NativePhase = 'before-attach' | 'during-attach' | 'after-detach';
export interface NativeProbe {
  phase: string;
  extensionId: string;
  witness: string;
}
export interface SavedCallback {
  value: string;
  cookiePresent: boolean;
}

/** Call explicitly inside an admitted proof stage; the caller owns Chrome/UI/lane/deadline. */
export async function createSharedNativeFixture(options: { sandbox: string }) {
  const sandbox = await realpath(options.sandbox);
  assert.equal(sandbox, options.sandbox);
  const directory = await mkdtemp(path.join(sandbox, 'native-fixture-'));
  assert.equal(await realpath(directory), directory);
  assert(directory.startsWith(sandbox + path.sep));
  const nonce = randomUUID();
  const phases = ['before-attach', 'during-attach', 'after-detach'] as const;
  const phaseTokens = Object.fromEntries(phases.map((phase) => [phase, randomUUID()]));
  const probes: { phase: string; extensionId: string; witness: string }[] = [];
  const saved: { value: string; cookiePresent: boolean }[] = [];
  let afterCookie = false;
  let origin = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (url.searchParams.get('run') !== nonce) {
      response.writeHead(404).end();
      return;
    }
    const cookie =
      request.headers.cookie?.split(';').some((v) => v.trim() === 'owned_native_cookie=' + nonce) ??
      false;
    if (url.pathname === '/extension-probe') {
      const phase = url.searchParams.get('phase') ?? '',
        extensionId = url.searchParams.get('extensionId') ?? '',
        witness = url.searchParams.get('witness') ?? '';
      if (
        phaseTokens[phase] !== url.searchParams.get('token') ||
        !/^[a-p]{32}$/.test(extensionId) ||
        !witness
      ) {
        response.writeHead(400).end();
        return;
      }
      probes.push({ phase, extensionId, witness });
      if (phase === 'after-detach' && cookie) afterCookie = true;
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/saved') {
      if (url.searchParams.get('phase') !== 'during-attach') {
        response.writeHead(400).end();
        return;
      }
      saved.push({ value: url.searchParams.get('value') ?? '', cookiePresent: cookie });
      response.writeHead(204).end();
      return;
    }
    if (!['/seed', '/during', '/after'].includes(url.pathname)) {
      response.writeHead(404).end();
      return;
    }
    if (url.pathname === '/seed')
      response.setHeader(
        'Set-Cookie',
        'owned_native_cookie=' + nonce + '; Path=/; SameSite=Lax; HttpOnly'
      );
    response.setHeader('Content-Type', 'text/html');
    const save = '/saved?run=' + nonce + '&phase=during-attach&value=';
    response.end(
      '<title>Owned native artifact page</title><h1>Owned native artifact fixture</h1><input aria-label="Name"><button onclick="fetch(' +
        JSON.stringify(save).replaceAll('"', '&quot;') +
        "+encodeURIComponent(document.querySelector('input').value),{credentials:'same-origin'}).then(()=>document.title='Saved native artifact')\">Save</button>"
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = 'http://127.0.0.1:' + address.port;
    const extension = path.join(directory, 'owned-extension');
    await mkdir(extension, { mode: 0o700 });
    const extensionManifest = JSON.stringify({
      manifest_version: 3,
      name: 'Owned native artifact witness',
      version: '1.0.0',
      content_scripts: [
        { matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle' },
      ],
    });
    const extensionContent =
      '(()=>{const expected=' +
      JSON.stringify({ origin, nonce, phaseTokens }) +
      ';if(location.origin!==expected.origin)return;const u=new URL(location.href),phase=u.searchParams.get("phase");if(u.searchParams.get("run")!==expected.nonce||u.searchParams.get("token")!==expected.phaseTokens[phase])return;let witness=sessionStorage.getItem("owned-tab-witness");if(!witness){witness=crypto.randomUUID();sessionStorage.setItem("owned-tab-witness",witness);}const p=document.createElement("p");p.textContent="Owned extension active";document.body.append(p);const q=new URL("/extension-probe",expected.origin);q.search=new URLSearchParams({run:expected.nonce,phase,token:expected.phaseTokens[phase],extensionId:chrome.runtime.id,witness});fetch(q,{credentials:"same-origin",cache:"no-store"});})();';
    await writeFile(path.join(extension, 'manifest.json'), extensionManifest);
    await writeFile(path.join(extension, 'content.js'), extensionContent);

    function url(pathname: string, phase: string) {
      const u = new URL(pathname, origin);
      u.search = new URLSearchParams({ run: nonce, phase, token: phaseTokens[phase] }).toString();
      return u.href;
    }
    const before = url('/seed', 'before-attach'),
      during = url('/during', 'during-attach'),
      after = url('/after', 'after-detach');

    let closePromise: Promise<void> | undefined;
    function close() {
      return (closePromise ??= (async () => {
        server.closeAllConnections();
        if (server.listening)
          await bounded(
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            ),
            2000,
            'Shared native fixture close'
          );
      })());
    }
    function probe(phase: NativePhase) {
      const entry = probes.find((value) => value.phase === phase);
      return entry ? { ...entry } : undefined;
    }
    function savedCallbacks() {
      return saved.map((value) => ({ ...value }));
    }
    function callbacksAtCount(count: number) {
      assert(saved.length <= count, 'Duplicate Save');
      return saved.length === count ? savedCallbacks() : undefined;
    }
    function assertSameTabWitness(phase: NativePhase) {
      const before = probe('before-attach'),
        current = probe(phase);
      assert(before && current, 'Missing extension tab witness');
      assert.equal(current.extensionId, before.extensionId);
      assert.equal(current.witness, before.witness, 'Human must keep the same owned tab');
    }
    return {
      directory,
      extensionDirectory: extension,
      origin,
      beforeAttachUrl: before,
      duringAttachUrl: during,
      afterDetachUrl: after,
      probe,
      savedCallbacks,
      callbacksAtCount,
      assertSameTabWitness,
      assertAfterDetachCookie: () =>
        assert(afterCookie, 'Owned HttpOnly cookie missing after detach'),
      metadata: () => ({
        directory,
        extensionDirectory: extension,
        nonce,
        phaseTokens: { ...phaseTokens },
        manifestSha256: createHash('sha256').update(extensionManifest).digest('hex'),
        contentSha256: createHash('sha256').update(extensionContent).digest('hex'),
        probes: probes.map((value) => ({ ...value })),
        saved: savedCallbacks(),
        afterDetachCookie: afterCookie,
      }),
      close,
    };
  } catch (error) {
    server.closeAllConnections();
    if (server.listening)
      await bounded(
        new Promise<void>((resolve) => server.close(() => resolve())),
        2000,
        'Failed shared fixture close'
      );
    throw error;
  }
}
