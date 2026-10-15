/** Prepared only. Import is inert; call runMockControls explicitly after a source-only check grant. */
const assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
const { EventEmitter } = require('node:events');
const callbacks = require('./remote-callbacks.cjs');
const { createFence, InspectorProtocol } = require('./protocol.cjs');
module.exports.runMockControls = async function runMockControls() {
  const sourceAudit = require('./source-audit.cjs').auditMaintainedSources();
  const ts = require('typescript'),
    {
      validateBoundary,
      admitFirstPause,
      admitPostGuardPause,
      validateLiveGuard,
      settleProbeReceipt,
    } = require('./source-boundary.cjs');
  const startupUrl = 'file:///owned/app.asar/node_modules/playwright-core/index.mjs';
  const startupFrame = {
    callFrameId: 'owned-frame',
    location: { scriptId: 'pw', lineNumber: 0, columnNumber: 0 },
  };
  const startup = {
    params: {
      reason: 'Break on start',
      hitBreakpoints: [],
      callFrames: [
        startupFrame,
        { functionName: '#asyncInstantiate', location: { scriptId: 'job' } },
      ],
    },
  };
  const startupEvents = [
    {
      method: 'Debugger.scriptParsed',
      params: { scriptId: 'pw', url: startupUrl, isModule: true, executionContextId: 1 },
    },
    {
      method: 'Debugger.scriptParsed',
      params: {
        scriptId: 'job',
        url: 'node:internal/modules/esm/module_job',
        executionContextId: 1,
      },
    },
  ];
  const startupExpected = {
    guardAttested: true,
    handled: 0,
    expectedUrl: startupUrl,
    executionContextId: 1,
  };
  admitPostGuardPause(startup, startupEvents, startupExpected);
  for (const change of [
    { guardAttested: false },
    { handled: 1 },
    { expectedUrl: 'file:///foreign/index.mjs' },
    { executionContextId: 2 },
  ]) {
    assert.throws(() =>
      admitPostGuardPause(startup, startupEvents, { ...startupExpected, ...change })
    );
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  for (const mutate of [
    (value) => {
      value.params.reason = 'exception';
    },
    (value) => {
      value.params.hitBreakpoints = ['unknown'];
    },
    (value) => {
      value.params.callFrames[0].location.columnNumber = 1;
    },
    (value) => {
      value.params.callFrames[1].functionName = 'foreign';
    },
  ]) {
    const wrong = clone(startup);
    mutate(wrong);
    assert.throws(() => admitPostGuardPause(wrong, startupEvents, startupExpected));
  }
  const wrongParent = clone(startupEvents);
  wrongParent[1].params.url = 'node:other';
  assert.throws(() => admitPostGuardPause(startup, wrongParent, startupExpected));
  const expectedLive = {
    pid: 314,
    execPath: '/owned/helper',
    guard: { pid: 314 },
    home: '/owned/home',
    canonicalData: '/owned/data',
    homeEnv: '/unchanged',
    codexEnv: undefined,
  };
  const live = { ...expectedLive, tests: { guardSelfTests: 3, identitiesUnchanged: true } };
  validateLiveGuard(live, expectedLive);
  for (const change of [
    { pid: 315 },
    { execPath: '/foreign/helper' },
    { guard: {} },
    { tests: { guardSelfTests: 2, identitiesUnchanged: true } },
  ]) {
    assert.throws(() => validateLiveGuard({ ...live, ...change }, expectedLive));
  }
  // Exercise the actual shared raw callback with fake fs only: no foreign or
  // real filesystem call can occur in this control, even if a guard regresses.
  let unguardedReads = 0;
  const unguarded = () => {
    unguardedReads++;
    throw Error('Unguarded fake filesystem read');
  };
  const fakeFs = {
    readFile: unguarded,
    readFileSync: unguarded,
    promises: { readFile: unguarded },
    realpathSync: (value) => value,
    appendFileSync: () => {},
    writeFileSync: () => {},
  };
  const rawContext = vm.createContext({
    module: { exports: {} },
    process: {
      pid: 314,
      execPath: '/owned/helper',
      argv: [],
      env: { HOME: '/unchanged', DORK_HOME: '/owned/data' },
    },
    URL,
    Buffer,
    require: (name) =>
      name === 'node:fs'
        ? fakeFs
        : name === 'node:os'
          ? {}
          : name === 'node:module'
            ? { syncBuiltinESMExports() {} }
            : require(name),
  });
  const raw = fs.readFileSync(
    require('node:path').join(__dirname, './discovery-guard.cjs'),
    'utf8'
  );
  vm.runInContext(raw, rawContext);
  const repeatGuards = rawContext.module.exports({
    fixtureHome: '/owned/home',
    ownedChromeProfile: '/owned/home/Library/Application Support/Google/Chrome',
    dataDirectory: '/owned/data',
    attestation: '/owned/attestation',
    guardLog: '/owned/log',
  });
  assert.equal(repeatGuards().guardSelfTests, 3);
  for (const [owner, name] of [
    [fakeFs, 'readFileSync'],
    [fakeFs, 'readFile'],
    [fakeFs.promises, 'readFile'],
  ]) {
    const installed = owner[name];
    owner[name] = unguarded;
    assert.throws(() => repeatGuards());
    assert.equal(unguardedReads, 0, 'All identities must be checked before any dummy read');
    owner[name] = installed;
  }
  assert.equal(repeatGuards().identitiesUnchanged, true);
  const ownedLocation = { scriptId: 'owned', lineNumber: 0, columnNumber: 12 };
  const ownedParsed = {
    params: { scriptId: 'owned', url: 'node:electron/js2c/utility_init' },
  };
  const ownedBreakpoint = { breakpointId: 'owned-break', locations: [] };
  const ownedResolved = [
    {
      method: 'Debugger.breakpointResolved',
      params: { breakpointId: 'owned-break', location: ownedLocation },
    },
  ];
  const pause = (ids) => ({
    params: { callFrames: [{ location: ownedLocation }], hitBreakpoints: ids },
  });
  assert.equal(
    admitFirstPause(pause(['owned-break']), ownedParsed, ownedBreakpoint, ownedResolved)
      .scheduledEmptyHitIds,
    false
  );
  assert.equal(
    admitFirstPause(pause([]), ownedParsed, ownedBreakpoint, ownedResolved).scheduledEmptyHitIds,
    true
  );
  assert.throws(() =>
    admitFirstPause(
      pause([]),
      { params: { ...ownedParsed.params, scriptId: 'foreign' } },
      ownedBreakpoint,
      ownedResolved
    )
  );
  assert.throws(() =>
    admitFirstPause(
      pause([]),
      { params: { ...ownedParsed.params, url: 'node:other' } },
      ownedBreakpoint,
      ownedResolved
    )
  );
  assert.throws(() =>
    admitFirstPause(pause([]), ownedParsed, ownedBreakpoint, [
      {
        method: 'Debugger.breakpointResolved',
        params: {
          breakpointId: 'owned-break',
          location: { ...ownedLocation, columnNumber: 13 },
        },
      },
    ])
  );
  assert.throws(() =>
    admitFirstPause(pause(['unknown']), ownedParsed, ownedBreakpoint, ownedResolved)
  );
  const sample =
    '(()=>{"use strict";const table={m(){return 1;}};const {runEntryPointWithESMLoader:load}=require("internal/modules/run_main");const _serviceStartupScript="owned";load(loader=>loader.import(_serviceStartupScript));})();';
  validateBoundary(ts, sample, sample.indexOf('const table'));
  const destructuring =
    'const {first}=owned;const {runEntryPointWithESMLoader:load}=require("internal/modules/run_main");const _serviceStartupScript="owned";load(loader=>loader.import(_serviceStartupScript));';
  validateBoundary(ts, destructuring, 0);
  assert.throws(
    () => validateBoundary(ts, destructuring, destructuring.indexOf('owned')),
    /structurally proven/
  );
  assert.throws(
    () => validateBoundary(ts, sample, sample.indexOf('return 1')),
    /structurally proven/
  );
  assert.throws(
    () => validateBoundary(ts, sample, sample.indexOf('load(loader')),
    /Pause must precede/
  );
  const source = fs.readFileSync(require.resolve('./remote-callbacks.cjs'), 'utf8');
  for (const callback of Object.values(callbacks)) {
    assert(source.includes(callback.toString()));
    assert(!/\b__name\s*\(/.test(callback.toString()));
    vm.runInNewContext('(' + callback.toString() + ')');
  }
  let now = 100,
    forks = 0;
  const writes = [];
  const nodePath = require('node:path');
  const context = vm.createContext({
    Date: { now: () => now },
    process: {
      resourcesPath: '/owned/App/Contents/Resources',
      getBuiltinModule: (name) =>
        name === 'path'
          ? nodePath
          : name === 'fs'
            ? {
                realpathSync: (value) => value,
                appendFileSync: (file, text) => writes.push({ file, text }),
              }
            : null,
    },
  });
  const remote = (name) => vm.runInContext('(' + callbacks[name].toString() + ')', context);
  const child = new EventEmitter();
  child.pid = 314;
  const electron = {
    utilityProcess: {
      fork() {
        forks++;
        return child;
      },
    },
  };
  const config = {
    key: 'fixture',
    deadline: 1000,
    port: 6201,
    dataDirectory: '/owned/data',
    admissions: '/owned/admissions',
  };
  remote('installFork')(electron, config);
  const expected = '/owned/App/Contents/Resources/app.asar/dist/server/server-entry.mjs';
  electron.utilityProcess.fork(expected, [], { env: { DORK_HOME: '/owned/data' } });
  child.emit('spawn');
  const consumed = remote('readCalls')(electron, 'fixture');
  assert.equal(consumed.wrapperStillInstalled, true);
  assert.equal(consumed.failed, false);
  assert.equal(consumed.admitted, true);
  assert(consumed.calls.find((call) => call.phase === 'spawn' && call.pid === 314));
  assert.equal(forks, 1);
  assert(writes.some((write) => JSON.parse(write.text).phase === 'admitted'));
  assert.throws(
    () => electron.utilityProcess.fork(expected, [], { env: { DORK_HOME: '/owned/data' } }),
    /Further utility fork refused/
  );
  assert.equal(forks, 1);
  remote('fenceFork')(electron, 'fixture');
  const fenced = remote('readCalls')(electron, 'fixture');
  assert.equal(fenced.closing, true);
  assert.equal(fenced.failed, true);
  assert.equal(fenced.wrapperStillInstalled, true);
  assert.throws(() =>
    electron.utilityProcess.fork(expected, [], { env: { DORK_HOME: '/owned/data' } })
  );
  assert.equal(forks, 1);
  const invalidContext = vm.createContext({
    Date: { now: () => 100 },
    process: {
      resourcesPath: '/owned/App/Contents/Resources',
      getBuiltinModule: (name) =>
        name === 'path'
          ? nodePath
          : name === 'fs'
            ? {
                realpathSync: (value) => {
                  if (!value) throw Error('missing private environment');
                  return value;
                },
                appendFileSync: () => {},
              }
            : null,
    },
  });
  const invalidInstall = vm.runInContext(
    '(' + callbacks.installFork.toString() + ')',
    invalidContext
  );
  let invalidForks = 0;
  const invalidElectron = {
    utilityProcess: {
      fork() {
        invalidForks++;
        return child;
      },
    },
  };
  invalidInstall(invalidElectron, { ...config, key: 'invalid' });
  assert.throws(() => invalidElectron.utilityProcess.fork(expected, [], { env: {} }));
  assert.throws(
    () => invalidElectron.utilityProcess.fork(expected, [], { env: { DORK_HOME: '/owned/data' } }),
    /Further utility fork refused/
  );
  assert.equal(invalidForks, 0);
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
      this.sent = [];
    }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) ?? [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    emit(name, value = {}) {
      for (const fn of this.listeners.get(name) ?? []) fn(value);
    }
    send(value) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.emit('close');
    }
  }
  const deadline = Date.now() + 10000;
  const positiveSocket = new FakeSocket(),
    positiveFence = createFence(deadline),
    positive = new InspectorProtocol(positiveSocket, positiveFence, deadline);
  const answer = positive.request('Debugger.enable');
  positiveSocket.emit('message', {
    data: JSON.stringify({ id: 1, result: { debuggerId: 'owned' } }),
  });
  assert.equal((await answer).debuggerId, 'owned');
  positiveFence.attestGuard();
  assert.equal(positiveFence.status().guardAttested, true);
  await positive.close();
  assert.equal(positiveFence.status().failed, null);
  const lostSocket = new FakeSocket(),
    lostFence = createFence(deadline),
    lost = new InspectorProtocol(lostSocket, lostFence, deadline);
  const pending = lost.request('Debugger.evaluateOnCallFrame').then(
    () => false,
    () => true
  );
  lostSocket.emit('close');
  assert.equal(await pending, true);
  assert.throws(() => lostFence.attestGuard());
  lostSocket.emit('message', { data: JSON.stringify({ id: 1, result: { guard: true } }) });
  assert.equal(lost.lateAcknowledgements, 1);
  assert.equal(lostFence.status().guardAttested, false);
  assert.throws(() => lost.request('Debugger.resume'));
  const guardedSocket = new FakeSocket(),
    guardedFence = createFence(deadline),
    guarded = new InspectorProtocol(guardedSocket, guardedFence, deadline);
  guardedFence.attestGuard();
  const guardedPending = guarded.request('Debugger.evaluateOnCallFrame').then(
    () => false,
    () => true
  );
  guardedSocket.emit('close');
  assert.equal(await guardedPending, true);
  guardedSocket.emit('message', { data: JSON.stringify({ id: 1, result: { tests: 3 } }) });
  assert.equal(guardedFence.status().guardAttested, true);
  assert(guardedFence.status().failed);
  assert.throws(() => guarded.request('Debugger.resume'));
  let clock = Date.now();
  const lateSocket = new FakeSocket(),
    lateFence = createFence(clock + 10000, () => clock),
    late = new InspectorProtocol(lateSocket, lateFence, deadline);
  const latePending = late.request('Runtime.runIfWaitingForDebugger').then(
    () => false,
    () => true
  );
  clock += 10001;
  lateSocket.emit('message', { data: JSON.stringify({ id: 1, result: {} }) });
  assert.equal(await latePending, true);
  assert.throws(() => lateFence.attestGuard());
  assert.throws(() => late.request('Debugger.resume'));
  await late.close();
  const cleanupSocket = new FakeSocket(),
    cleanupFence = createFence(deadline);
  const cleanupProtocol = new InspectorProtocol(cleanupSocket, cleanupFence, deadline);
  cleanupFence.attestGuard();
  const cleanupReceipt = { status: 'passed-owned-node-inspector-mechanism-only' };
  let finishAcknowledgement;
  const acknowledgement = new Promise((resolve) => {
    finishAcknowledgement = resolve;
  });
  const finalizeAfterAck = (async () => {
    await acknowledgement;
    cleanupReceipt.finalFence = cleanupFence.status();
    settleProbeReceipt(cleanupReceipt);
  })();
  // Actual protocol loss while the independent main-process cleanup ack waits.
  cleanupSocket.emit('close');
  finishAcknowledgement();
  await finalizeAfterAck;
  assert.equal(cleanupReceipt.status, 'failed');
  assert(cleanupReceipt.finalFence.failed);
  assert.throws(() => cleanupProtocol.request('Debugger.resume'));
  assert.equal(
    settleProbeReceipt({ status: 'passed', finalFence: { failed: null, guardAttested: true } }),
    'passed'
  );
  assert.equal(
    settleProbeReceipt({
      status: 'passed',
      finalFence: { failed: null, guardAttested: true },
      forkFenceError: 'ack failed',
    }),
    'failed'
  );
  return {
    ...sourceAudit,
    cleanupWindowDisconnectRefused: true,
    postGuardStartupAdmission: true,
    postGuardRefusals: true,
    repeatableActualRawGuardTests: true,
    replacedWrapperNoDummyRead: true,
    postGuardDisconnectPermanent: true,
    rawCallbacksSerialized: true,
    structuralEntryControl: true,
    nestedModuleEntryRefused: true,
    singleFork: true,
    secondForkRejectedBeforeOriginal: true,
    closingForkRejected: true,
    invalidEnvironmentPermanent: true,
    positiveProtocolAck: true,
    unexpectedDisconnectPermanent: true,
    lateAckPermanent: true,
    executedNative: false,
  };
};
