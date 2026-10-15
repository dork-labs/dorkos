/** Explicit inspector harness. No top-level app, socket, browser or process launch. */
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { createHash, randomUUID } = require('node:crypto'),
  { createRequire } = require('node:module');
const { execFile } = require('node:child_process'),
  { promisify } = require('node:util'),
  { createServer } = require('node:net');
const { pathToFileURL } = require('node:url');
const exec = promisify(execFile),
  { createFence, InspectorProtocol } = require('./protocol.cjs');
const callbacks = require('./remote-callbacks.cjs');
const {
  validateBoundary,
  admitFirstPause,
  admitPostGuardPause,
  validateLiveGuard,
  settleProbeReceipt,
} = require('./source-boundary.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports.probeInspector = async function probeInspector(application, options) {
  const { root, candidate, fixtureHome, dataDirectory, sandbox, output, deadline } = options;
  const fence = createFence(deadline),
    key = 'owned-inspector-' + randomUUID();
  const receipt = {
    status: 'failed',
    mechanismOnly: true,
    nativeDiscoveryAttempted: false,
    negativePathMayImportUnguardedServer: true,
    output,
    key,
  };
  let protocol,
    socket,
    installed = false,
    restartPromise;
  async function step(run, maximum = 5000) {
    fence.admit();
    let timer;
    try {
      const result = await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fence.fail(Error('Inspector step deadline'))),
            Math.max(1, Math.min(maximum, deadline - Date.now()))
          );
        }),
      ]);
      fence.admit();
      return result;
    } catch (error) {
      throw fence.fail(error);
    } finally {
      clearTimeout(timer);
    }
  }
  async function poll(read, maximum = 10000) {
    return step(async () => {
      for (;;) {
        fence.admit();
        const value = await read();
        if (value !== undefined) return value;
        await delay(50);
      }
    }, maximum);
  }
  async function mainRead() {
    const value = await step(() => application.evaluate(callbacks.readCalls, key));
    assert(value.wrapperStillInstalled);
    assert(!value.failed);
    return value;
  }
  try {
    for (const value of [root, candidate, fixtureHome, dataDirectory, sandbox, output])
      assert.equal(await fs.realpath(value), value);
    const pnpm = path.join(root, 'node_modules/.pnpm');
    const packages = (await fs.readdir(pnpm)).filter((name) => name.startsWith('@electron+fuses@'));
    assert.equal(packages.length, 1);
    const fusesPath = path.join(pnpm, packages[0], 'node_modules/@electron/fuses');
    const fuses = createRequire(path.join(fusesPath, 'package.json'))('./dist/index.js');
    receipt.wire = await fuses.getCurrentFuseWire(candidate);
    assert.equal(
      receipt.wire[fuses.FuseV1Options.EnableNodeCliInspectArguments],
      49,
      'Actual candidate inspect fuse must already be enabled'
    );
    receipt.identity = await step(() => application.evaluate(callbacks.identity));
    assert.equal(receipt.identity.packaged, true);
    assert.equal(receipt.identity.electron, '41.10.7');
    assert.equal(receipt.identity.appPath, path.join(candidate, 'Contents/Resources/app.asar'));
    const reservation = createServer();
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const admissions = path.join(output, 'fork-admissions.jsonl');
    receipt.adapter = await step(() =>
      application.evaluate(callbacks.installFork, {
        key,
        deadline,
        port,
        dataDirectory,
        admissions,
      })
    );
    installed = true;
    const page = await step(() => application.firstWindow());
    const base = new URL(page.url()).origin;
    // Retain original renderer restart: readiness cannot finish until this independent handshake resumes it.
    restartPromise = page.evaluate(callbacks.restartRenderer, deadline);
    void restartPromise.catch((error) => fence.fail(error));
    const spawned = await poll(async () => {
      const state = await mainRead();
      return state.calls.find((call) => call.phase === 'spawn' && Number.isInteger(call.pid));
    });
    const admitted = (await mainRead()).calls.find((call) => call.phase === 'admitted');
    assert(admitted);
    receipt.admission = admitted;
    receipt.utilityPid = spawned.pid;
    let initialIdentity;
    async function attestInspectorOwner() {
      fence.admit();
      const table = (
        await exec('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
          timeout: 2000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
      const rows = table.split('\n').flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                identity: match[1] + ':' + match[3],
                command: match[4],
              },
            ]
          : [];
      });
      const child = rows.find((row) => row.pid === spawned.pid);
      assert(child);
      if (!initialIdentity)
        assert(
          child.command.includes(candidate),
          'Initial utility command must name the owned candidate helper'
        );
      const seen = new Set();
      let cursor = child;
      while (cursor && !seen.has(cursor.pid) && cursor.pid !== receipt.identity.pid) {
        seen.add(cursor.pid);
        cursor = rows.find((row) => row.pid === cursor.parent);
      }
      assert.equal(
        cursor?.pid,
        receipt.identity.pid,
        'Utility must descend from the actual owned app'
      );
      if (initialIdentity) assert.equal(child.identity, initialIdentity);
      else initialIdentity = child.identity;
      const listener = (
        await exec(
          '/usr/sbin/lsof',
          ['-nP', '-a', '-p', String(spawned.pid), '-iTCP:' + port, '-sTCP:LISTEN', '-Fn'],
          { timeout: 2000 }
        )
      ).stdout;
      assert(listener.split('\n').includes('p' + spawned.pid));
      assert(
        listener.split('\n').includes('n127.0.0.1:' + port),
        'Inspector must bind exact loopback address'
      );
      return child;
    }
    receipt.utilityIdentity = await poll(async () => {
      try {
        return await attestInspectorOwner();
      } catch (error) {
        if (Date.now() + 1000 >= deadline) throw error;
        return undefined;
      }
    });
    const targets = await step(async () => {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
        signal: AbortSignal.timeout(2000),
      });
      assert(response.ok);
      return response.json();
    });
    assert.equal(targets.length, 1);
    const endpoint = new URL(targets[0].webSocketDebuggerUrl);
    assert.equal(endpoint.protocol, 'ws:');
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.port, String(port));
    assert(/^\/[a-zA-Z0-9-]+$/.test(endpoint.pathname));
    await attestInspectorOwner();
    assert.equal(typeof WebSocket, 'function', 'Use host Node built-in WebSocket');
    socket = new WebSocket(endpoint.href);
    protocol = new InspectorProtocol(socket, fence, deadline);
    await step(
      () =>
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true });
          socket.addEventListener('error', reject, { once: true });
        })
    );
    await protocol.request('Runtime.enable');
    await protocol.request('Debugger.enable');
    const breakpoint = await protocol.request('Debugger.setBreakpointByUrl', {
      url: 'node:electron/js2c/utility_init',
      lineNumber: 0,
      columnNumber: 0,
    });
    assert(breakpoint.breakpointId);
    receipt.breakpoint = breakpoint;
    await protocol.request('Runtime.runIfWaitingForDebugger');
    const paused = await poll(async () =>
      protocol.events.find((event) => event.method === 'Debugger.paused')
    );
    receipt.firstPause = paused; // Never resume an unqualified pause to hunt a later one.
    const frame = paused.params.callFrames[0];
    assert(frame);
    const resolved = protocol.events.find(
      (event) =>
        event.method === 'Debugger.breakpointResolved' &&
        event.params.breakpointId === breakpoint.breakpointId &&
        event.params.location.scriptId === frame.location.scriptId &&
        event.params.location.lineNumber === frame.location.lineNumber &&
        event.params.location.columnNumber === frame.location.columnNumber
    );
    const initialResolved = breakpoint.locations?.find(
      (location) =>
        location.scriptId === frame.location.scriptId &&
        location.lineNumber === frame.location.lineNumber &&
        location.columnNumber === frame.location.columnNumber
    );
    const parsed = protocol.events.find(
      (event) =>
        event.method === 'Debugger.scriptParsed' &&
        event.params.scriptId === frame.location.scriptId
    );
    assert.equal(parsed?.params.url, 'node:electron/js2c/utility_init');
    const source = (
      await protocol.request('Debugger.getScriptSource', { scriptId: frame.location.scriptId })
    ).scriptSource;
    assert.equal(typeof source, 'string');
    // First actual executable location must be before the source's server-entry loader invocation.
    const lines = source.split('\n'),
      offset =
        lines.slice(0, frame.location.lineNumber).reduce((sum, line) => sum + line.length + 1, 0) +
        frame.location.columnNumber;
    // Capture diagnostic evidence before conservative boundary assertions can refuse.
    // Capture failure is secondary: preserve the original later boundary/protocol error.
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const sourcePath = path.join(output, 'utility-init-source.js');
    receipt.boundaryDiagnostic = {
      frame,
      script: parsed.params,
      resolved: resolved?.params ?? {
        breakpointId: breakpoint.breakpointId,
        location: initialResolved,
      },
      offset,
      sourceSha256,
      sourcePath,
      sourceBytes: Buffer.byteLength(source, 'utf8'),
      captured: false,
    };
    try {
      assert(
        Buffer.byteLength(source, 'utf8') <= 4 * 1024 * 1024,
        'Utility diagnostic source bound'
      );
      await fs.writeFile(sourcePath, source, { flag: 'wx', mode: 0o600 });
      receipt.boundaryDiagnostic.captured = true;
    } catch (error) {
      receipt.boundaryDiagnostic.captureError = String(error);
    }
    receipt.firstPauseAdmission = admitFirstPause(paused, parsed, breakpoint, protocol.events);
    const ts = createRequire(path.join(root, 'package.json'))('typescript');
    const boundary = validateBoundary(ts, source, offset);
    const possible = await protocol.request('Debugger.getPossibleBreakpoints', {
      start: { scriptId: frame.location.scriptId, lineNumber: 0, columnNumber: 0 },
      end: {
        scriptId: frame.location.scriptId,
        lineNumber: frame.location.lineNumber,
        columnNumber: frame.location.columnNumber + 1,
      },
    });
    assert(possible.locations?.length > 0);
    const first = possible.locations[0];
    assert.equal(first.lineNumber, frame.location.lineNumber);
    assert.equal(
      first.columnNumber,
      frame.location.columnNumber,
      'Require first executable breakpoint, not a later guessed statement'
    );
    function assertNoServerScripts() {
      const hits = protocol.events.filter(
        (event) =>
          event.method === 'Debugger.scriptParsed' &&
          /app\.asar\/dist\/server|playwright-core/.test(event.params.url)
      );
      assert.equal(hits.length, 0, 'Server/Playwright parsed before guard');
    }
    assertNoServerScripts();
    const readiness = await protocol.request('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression:
        '({pid:process.pid,execPath:process.execPath,type:process.type,electron:process.versions.electron,builtin:typeof process.getBuiltinModule,rawHome:process.env.HOME,rawCodexHome:process.env.CODEX_HOME})',
      returnByValue: true,
    });
    assert(!readiness.exceptionDetails);
    assert.equal(readiness.result.value.pid, spawned.pid);
    assert(
      readiness.result.value.execPath.startsWith(candidate + '/Contents/Frameworks/'),
      'Actual utility executable must belong to the candidate'
    );
    assert.equal(readiness.result.value.electron, '41.10.7');
    assert.equal(readiness.result.value.builtin, 'function');
    const profile = path.join(fixtureHome, 'Library/Application Support/Google/Chrome');
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    const guardPath = path.join(root, 'scripts/local-browser/native/discovery-guard.cjs');
    const raw = await fs.readFile(guardPath, 'utf8');
    // Reuse the shared strict canonical raw guard unchanged; environment stays untouched.
    const guardStart = raw.indexOf('function activate'),
      guardEnd = raw.lastIndexOf(';');
    assert(guardStart >= 0 && guardEnd > guardStart);
    const guardFunction = raw.slice(guardStart, guardEnd);
    const bindings = {
      fixtureHome,
      ownedChromeProfile: profile,
      dataDirectory,
      attestation: path.join(output, 'guard-' + spawned.pid + '.json'),
      guardLog: path.join(output, 'discovery-' + spawned.pid + '.jsonl'),
    };
    const guardKey = 'ownedGuard_' + key.replaceAll('-', '_');
    const testKey = guardKey + '_testReadGuards';
    const expression =
      '(()=>{const require=id=>process.getBuiltinModule(id);const testReadGuards=(' +
      guardFunction +
      ')(' +
      JSON.stringify(bindings) +
      ');globalThis[' +
      JSON.stringify(testKey) +
      ']=testReadGuards;globalThis[' +
      JSON.stringify(guardKey) +
      ']={pid:process.pid,home:process.getBuiltinModule("os").homedir(),canonicalData:process.getBuiltinModule("fs").realpathSync(process.env.DORK_HOME),homeEnv:process.env.HOME,codexEnv:process.env.CODEX_HOME};return globalThis[' +
      JSON.stringify(guardKey) +
      '];})()';
    assertNoServerScripts();
    const injected = await protocol.request('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
    });
    assert(!injected.exceptionDetails);
    assert.equal(injected.result.value.pid, spawned.pid);
    assert.equal(injected.result.value.home, fixtureHome);
    assert.equal(injected.result.value.canonicalData, dataDirectory);
    assert.equal(injected.result.value.homeEnv, readiness.result.value.rawHome);
    assert.equal(injected.result.value.codexEnv, readiness.result.value.rawCodexHome);
    const readback = await protocol.request('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: 'globalThis[' + JSON.stringify(guardKey) + ']',
      returnByValue: true,
    });
    assert.deepEqual(readback.result.value, injected.result.value);
    const attestation = JSON.parse(await fs.readFile(bindings.attestation, 'utf8'));
    assert.equal(attestation.pid, spawned.pid);
    assert.equal(attestation.guardSelfTests, 3);
    assert.equal(attestation.homePreserved, true);
    assert.equal(attestation.codexHomePreserved, true);
    assert.equal(await fs.realpath(attestation.dataDirectory), dataDirectory);
    fence.attestGuard();
    receipt.pause = {
      frame,
      script: parsed.params,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      offset,
      boundary,
      resolved: resolved?.params ?? {
        breakpointId: breakpoint.breakpointId,
        location: initialResolved,
      },
      firstExecutable: first,
    };
    receipt.guard = {
      sourcePath: guardPath,
      sourceSha256: createHash('sha256').update(raw).digest('hex'),
      expressionSha256: createHash('sha256').update(expression).digest('hex'),
      readback: readback.result.value,
      attestation,
    };
    const expectedLive = {
      pid: spawned.pid,
      execPath: readiness.result.value.execPath,
      guard: readback.result.value,
      home: fixtureHome,
      canonicalData: dataDirectory,
      homeEnv: readiness.result.value.rawHome,
      codexEnv: readiness.result.value.rawCodexHome,
    };
    await protocol.request('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
    const firstPauseCount = protocol.events.filter(
      (event) => event.method === 'Debugger.paused'
    ).length;
    await protocol.request('Debugger.resume');
    let restartOutcome;
    void restartPromise.then(
      (value) => {
        restartOutcome = { value };
      },
      (error) => {
        restartOutcome = { error };
      }
    );
    let consumedPauses = firstPauseCount,
      startupPauses = 0;
    receipt.postGuardPauses = [];
    await step(
      async () => {
        for (;;) {
          fence.admit();
          const pauses = protocol.events.filter((event) => event.method === 'Debugger.paused');
          if (pauses.length > consumedPauses) {
            const next = pauses[consumedPauses++];
            const evidence = { pause: next, admitted: false };
            receipt.postGuardPauses.push(evidence);
            const admission = admitPostGuardPause(next, protocol.events, {
              guardAttested: fence.status().guardAttested,
              handled: startupPauses,
              expectedUrl: pathToFileURL(
                path.join(
                  candidate,
                  'Contents/Resources/app.asar/node_modules/playwright-core/index.mjs'
                )
              ).href,
              executionContextId: parsed.params.executionContextId,
            });
            startupPauses++; // Latch before any asynchronous attestation/resume.
            await attestInspectorOwner();
            const live = await protocol.request('Debugger.evaluateOnCallFrame', {
              callFrameId: admission.frame.callFrameId,
              expression:
                '({pid:process.pid,execPath:process.execPath,guard:globalThis[' +
                JSON.stringify(guardKey) +
                '],home:process.getBuiltinModule("os").homedir(),canonicalData:process.getBuiltinModule("fs").realpathSync(process.env.DORK_HOME),homeEnv:process.env.HOME,codexEnv:process.env.CODEX_HOME,tests:globalThis[' +
                JSON.stringify(testKey) +
                ']()})',
              returnByValue: true,
            });
            assert(!live.exceptionDetails);
            validateLiveGuard(live.result.value, expectedLive);
            evidence.admission = admission;
            evidence.live = live.result.value;
            evidence.admitted = true;
            await protocol.request('Debugger.resume');
            continue;
          }
          if (restartOutcome) {
            if (restartOutcome.error) throw restartOutcome.error;
            receipt.restart = restartOutcome.value;
            return;
          }
          await delay(25);
        }
      },
      Math.max(1, deadline - Date.now())
    );
    assert.equal(receipt.restart.ok, true);
    await attestInspectorOwner();
    const apiPort = Number(new URL(base).port);
    const apiListener = (
      await exec(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', String(spawned.pid), '-iTCP:' + apiPort, '-sTCP:LISTEN', '-t'],
        { timeout: 2000 }
      )
    ).stdout;
    assert(apiListener.trim().split(/\s+/).includes(String(spawned.pid)));
    async function passive(route) {
      const response = await step(() => fetch(base + route, { signal: AbortSignal.timeout(2000) }));
      assert(response.ok);
      return step(() => response.json());
    }
    assert.equal(await fs.realpath((await passive('/api/config')).dorkHome), dataDirectory);
    assert.equal((await passive('/api/local-browser/state')).status, 'disconnected');
    receipt.capabilities = await passive('/api/local-browser/capabilities');
    assert.equal(receipt.capabilities.playwrightVersion, '1.63.0');
    const survived = await protocol.request('Runtime.evaluate', {
      expression:
        '({guard:globalThis[' +
        JSON.stringify(guardKey) +
        '],pid:process.pid,execPath:process.execPath,home:process.getBuiltinModule("os").homedir(),canonicalData:process.getBuiltinModule("fs").realpathSync(process.env.DORK_HOME),homeEnv:process.env.HOME,codexEnv:process.env.CODEX_HOME,tests:globalThis[' +
        JSON.stringify(testKey) +
        ']()})',
      returnByValue: true,
    });
    assert(!survived.exceptionDetails);
    validateLiveGuard(survived.result.value, expectedLive);
    receipt.guard.afterServerReady = survived.result.value;
    await mainRead();
    assert.equal(
      protocol.events.filter((event) => event.method === 'Debugger.paused').length,
      consumedPauses,
      'Unexpected later startup pause'
    );
    if (options.onReady !== undefined) {
      assert.equal(typeof options.onReady, 'function');
      receipt.mechanismOnly = false;
      // This continuation stays INSIDE the same inspector/fork/operation fence.
      // The mechanism-only caller supplies none and retains its existing path.
      const attest = () =>
        step(async () => {
          await mainRead();
          await attestInspectorOwner();
          const listener = (
            await exec(
              '/usr/sbin/lsof',
              ['-nP', '-a', '-p', String(spawned.pid), '-iTCP:' + apiPort, '-sTCP:LISTEN', '-t'],
              { timeout: 2000 }
            )
          ).stdout;
          assert(listener.trim().split(/\s+/).includes(String(spawned.pid)));
          assert.equal(await fs.realpath((await passive('/api/config')).dorkHome), dataDirectory);
          const live = await protocol.request('Runtime.evaluate', {
            expression:
              '({guard:globalThis[' +
              JSON.stringify(guardKey) +
              '],pid:process.pid,execPath:process.execPath,home:process.getBuiltinModule("os").homedir(),canonicalData:process.getBuiltinModule("fs").realpathSync(process.env.DORK_HOME),homeEnv:process.env.HOME,codexEnv:process.env.CODEX_HOME,tests:globalThis[' +
              JSON.stringify(testKey) +
              ']()})',
            returnByValue: true,
          });
          assert(!live.exceptionDetails);
          validateLiveGuard(live.result.value, expectedLive);
          assert.equal(
            protocol.events.filter((event) => event.method === 'Debugger.paused').length,
            consumedPauses,
            'Unexpected pause during native acceptance'
          );
          await mainRead();
          return live.result.value;
        });
      await attest();
      receipt.nativeContinuation = await step(
        () =>
          options.onReady({
            pid: spawned.pid,
            base,
            renderer: page,
            guardLog: bindings.guardLog,
            attest,
            noteNativeOpenAttempt: () => {
              fence.admit();
              receipt.nativeDiscoveryAttempted = true;
            },
            stage: (run, maximum = 45000) => step(run, Math.min(maximum, deadline - Date.now())),
          }),
        Math.max(1, deadline - Date.now())
      );
      await attest();
    }
    fence.admit();
    receipt.status = 'passed-owned-node-inspector-mechanism-only';
  } catch (error) {
    fence.fail(error);
    receipt.status = 'failed';
    receipt.error = error.stack ?? String(error);
    throw error;
  } finally {
    if (installed) {
      let timer;
      try {
        await Promise.race([
          application.evaluate(callbacks.fenceFork, key),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Fork fence acknowledgement deadline')), 2000);
          }),
        ]);
      } catch (error) {
        receipt.forkFenceError = String(error);
        receipt.status = 'failed';
      } finally {
        clearTimeout(timer);
      }
    }
    // Closing may allow failed unguarded startup. No browser-open/model/tool request exists anywhere here.
    receipt.finalFence = fence.status();
    receipt.protocol = {
      events: protocol?.events,
      lateAcknowledgements: protocol?.lateAcknowledgements,
    };
    if (protocol) await protocol.close();
    else socket?.close();
    receipt.wrapperRetainedUntilOwnedAppPhysicalClosure = installed;
    settleProbeReceipt(receipt);
    if (restartPromise) void restartPromise.catch(() => undefined);
    await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return receipt;
};
