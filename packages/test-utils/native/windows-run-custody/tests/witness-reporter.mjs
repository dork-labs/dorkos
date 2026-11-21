/** Capture the real Node test events and the native observations asserted by each witness. */
const observationPrefix = 'DORKOS_WINDOWS_WITNESS ';
export const witnessFiles = Object.freeze([
  'owner-attempt-witness.mjs',
  'guardian-launcher-witness.mjs',
]);
export const witnessCases = Object.freeze([
  ...[
    'live-owners',
    'wrong-proof',
    'main-lost',
    'scope-lost',
    'main-lost-after-resume',
    'scope-lost-after-resume',
    'main-lost-with-descendant-after-leader-exit',
  ].map((name) => `Windows owner attempt: ${name}`),
  ...['normal-stdio-exit', 'spawn-failed', 'stop-before-admission', 'stop-after-resume'].map(
    (name) => `Windows private guardian launcher: ${name}`
  ),
]);

export function witnessObservation(context, observation) {
  context.diagnostic(observationPrefix + JSON.stringify({ name: context.name, observation }));
}

export default async function* witnessReporter(events) {
  for await (const { type, data } of events) {
    if (type === 'test:pass' || type === 'test:fail') {
      yield JSON.stringify({
        type,
        name: data.name,
        skipped: Boolean(data.skip || data.todo),
        durationMs: data.details?.duration_ms,
        error: data.details?.error?.message,
      }) + '\n';
    } else if (type === 'test:diagnostic' && data.message.startsWith(observationPrefix)) {
      yield JSON.stringify({
        type: 'observation',
        payload: JSON.parse(data.message.slice(observationPrefix.length)),
      }) + '\n';
    } else if (type === 'test:stdout' || type === 'test:stderr' || type === 'test:diagnostic') {
      yield JSON.stringify({ type, message: data.message }) + '\n';
    }
  }
}

export function readWitnessArchitecture(arch, nodeVersion, nativeOutput) {
  const match = /^(\d+) (\d+)$/.exec(nativeOutput.trim());
  if (!match) throw new Error('Windows fixture returned no architecture evidence');
  const [processMachine, nativeMachine] = match.slice(1).map(Number);
  if (arch === 'x64' && processMachine === 0 && nativeMachine === 0x8664) {
    return { processMachine, nativeMachine, scope: 'native-x64' };
  }
  if (arch === 'arm64' && processMachine === 0 && nativeMachine === 0xaa64) {
    return { processMachine, nativeMachine, scope: 'native-arm64' };
  }
  if (
    arch === 'ia32' &&
    /^22\./.test(nodeVersion) &&
    processMachine === 0x14c &&
    nativeMachine === 0x8664
  ) {
    return { processMachine, nativeMachine, scope: 'ia32-process-only' };
  }
  throw new Error('Windows fixture architecture does not support the requested witness coverage');
}

function provesObservation(name, observation) {
  if (!observation) return false;
  const [suite, scenario] = name.split(': ');
  const target = observation.target;
  const exited = (tuple) => tuple?.[0] === 0 && tuple[1] === null;
  const ownersJoined = observation.ownerExits?.length === 2 && observation.ownerExits.every(exited);

  if (suite === 'Windows private guardian launcher') {
    const terminal = observation.terminal;
    if (!terminal || terminal.kind !== 'terminal' || observation.stdoutClosed !== true)
      return false;
    if (scenario === 'stop-before-admission') {
      return terminal.outcome === 'stopped' && !terminal.acquired && target === null;
    }
    if (scenario === 'spawn-failed') {
      return (
        terminal.outcome === 'spawn-failed' && !terminal.acquired && target === null && ownersJoined
      );
    }
    return (
      target?.pid > 0 &&
      terminal.joined &&
      terminal.resumed &&
      terminal.cleanupError === 0 &&
      ownersJoined &&
      (scenario === 'normal-stdio-exit'
        ? terminal.outcome === 'completed' && terminal.code === 37
        : terminal.outcome === 'stopped' &&
          terminal.code === 1223 &&
          observation.ordinary === 'finished')
    );
  }

  if (!observation.markers?.includes('closed') || !exited(observation.fixtureExit) || !ownersJoined)
    return false;
  if (scenario === 'wrong-proof') {
    return target === null && observation.markers.includes('admission-refused');
  }
  if (!(target?.pid > 0 && target.joined && target.cleanupError === 0)) return false;
  if (scenario === 'main-lost' || scenario === 'scope-lost') {
    return !target.resumed && observation.markers.includes('owner-lost-before-resume');
  }
  if (scenario === 'live-owners') return target.resumed && target.code === 37;
  const lost = scenario === 'scope-lost-after-resume' ? 'scope' : 'main';
  const descendant = scenario === 'main-lost-with-descendant-after-leader-exit';
  const live = descendant ? 'descendant-running-after-leader-exit' : 'target-running';
  return (
    target.resumed &&
    observation.markers.includes(live) &&
    target.code === (descendant ? 37 : 1223) &&
    observation.markers.includes(lost + '-owner-closed')
  );
}

export function summarizeWitnessEvents(records, exitCode, signal) {
  const cases = witnessCases.map((name) => {
    const outcomes = records.filter(
      (row) => (row.type === 'test:pass' || row.type === 'test:fail') && row.name === name
    );
    const observations = records.filter(
      (row) => row.type === 'observation' && row.payload.name === name
    );
    if (outcomes.length !== 1) {
      return { name, status: outcomes.length === 0 ? 'not-run' : 'duplicate-result' };
    }
    const [outcome] = outcomes;
    const observation = observations.length === 1 ? observations[0].payload.observation : undefined;
    let status = 'unverified';
    if (outcome.skipped) status = 'skipped';
    else if (outcome.type === 'test:fail') status = 'failed';
    else if (provesObservation(name, observation)) status = 'passed';
    return { name, status, durationMs: outcome.durationMs, error: outcome.error, observation };
  });
  const passed = cases.filter((entry) => entry.status === 'passed').length;
  const extraFailure = records.some(
    (row) =>
      !witnessCases.includes(row.name) &&
      (row.type === 'test:fail' || (row.type === 'test:pass' && row.name.startsWith('Windows ')))
  );
  const passedAll =
    passed === witnessCases.length && exitCode === 0 && signal === null && !extraFailure;
  return { passedAll, selected: witnessCases.length, passed, cases };
}
