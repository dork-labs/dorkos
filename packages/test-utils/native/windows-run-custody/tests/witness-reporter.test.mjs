import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import {
  readWitnessArchitecture,
  summarizeWitnessEvents,
  witnessCases,
} from './witness-reporter.mjs';

const owners = [
  [0, null],
  [0, null],
];

function validRecords() {
  return witnessCases.flatMap((name) => {
    const [suite, scenario] = name.split(': ');
    const observation = { ownerExits: owners };
    if (suite === 'Windows private guardian launcher') {
      const started = scenario === 'normal-stdio-exit' || scenario === 'stop-after-resume';
      const outcome =
        scenario === 'normal-stdio-exit'
          ? 'completed'
          : scenario === 'spawn-failed'
            ? 'spawn-failed'
            : 'stopped';
      observation.stdoutClosed = true;
      observation.target = started ? { pid: 91 } : null;
      observation.ordinary = 'finished';
      observation.terminal = {
        kind: 'terminal',
        outcome,
        acquired: started,
        resumed: started,
        joined: started,
        cleanupError: 0,
        code: outcome === 'completed' ? 37 : 1223,
      };
    } else {
      observation.fixtureExit = [0, null];
      observation.markers = ['closed'];
      observation.target = { pid: 92, resumed: true, joined: true, code: 37, cleanupError: 0 };
      if (scenario === 'wrong-proof') {
        observation.target = null;
        observation.markers.push('admission-refused');
      } else if (scenario === 'scope-lost' || scenario === 'main-lost') {
        observation.target.resumed = false;
        observation.markers.push('owner-lost-before-resume');
      } else if (scenario !== 'live-owners') {
        if (scenario.includes('descendant')) {
          observation.markers.push('descendant-running-after-leader-exit');
        } else {
          observation.target.code = 1223;
          observation.markers.push('target-running');
        }
        observation.markers.push(
          scenario.startsWith('scope-') ? 'scope-owner-closed' : 'main-owner-closed'
        );
      }
    }
    return [
      { type: 'observation', payload: { name, observation } },
      { type: 'test:pass', name, skipped: false },
    ];
  });
}

test('actual architecture facts distinguish native machines from ia32 process-only coverage', () => {
  assert.equal(readWitnessArchitecture('x64', '24.19.0', '0 34404\r\n').scope, 'native-x64');
  assert.equal(readWitnessArchitecture('arm64', '24.19.0', '0 43620').scope, 'native-arm64');
  assert.equal(readWitnessArchitecture('ia32', '22.23.3', '332 34404').scope, 'ia32-process-only');
  for (const [arch, version, facts] of [
    ['x64', '24.19.0', '34404 43620'],
    ['arm64', '24.19.0', '0 34404'],
    ['ia32', '24.19.0', '332 34404'],
    ['ia32', '22.23.3', '332 43620'],
    ['arm64', '24.19.0', ''],
  ])
    assert.throws(() => readWitnessArchitecture(arch, version, facts), /architecture/);
});

test('all eleven cases need a genuine result, corresponding native observation and clean runner exit', () => {
  const events = validRecords();
  const complete = summarizeWitnessEvents(events, 0, null);
  assert.equal(complete.passedAll, true);
  assert.equal(complete.passed, 11);
  assert.deepEqual(
    complete.cases.map(({ name }) => name),
    witnessCases
  );
  assert.equal(summarizeWitnessEvents(events, 1, null).passedAll, false);
  assert.equal(summarizeWitnessEvents(events, 0, 'SIGTERM').passedAll, false);
  assert.equal(
    summarizeWitnessEvents([...events, { type: 'test:fail', name: 'file wrapper' }], 0, null)
      .passedAll,
    false
  );
});

test('no case is credited when events are missing, duplicate, skipped, failed or lack native proof', () => {
  const events = validRecords();
  events[0].payload.observation.target.joined = false;
  events[3].skipped = true;
  events[5].type = 'test:fail';
  events.push(events[7]);
  const missing = events.splice(9, 1);
  assert.equal(missing.length, 1);
  const report = summarizeWitnessEvents(events, 0, null);
  assert.equal(report.passedAll, false);
  assert.deepEqual(
    report.cases.slice(0, 5).map(({ status }) => status),
    ['unverified', 'skipped', 'failed', 'duplicate-result', 'not-run']
  );
});

test('pinned Node reporter preserves real case names, skips, observations and raw output', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const scratch = await mkdtemp(join(root, '.build-reporter-test-'));
  t.after(() => rm(scratch, { recursive: true }));
  const fixture = join(scratch, 'portable-example.mjs');
  const reporter = new URL('./witness-reporter.mjs', import.meta.url).href;
  await writeFile(
    fixture,
    `
    import test from 'node:test';
    import { witnessObservation } from ${JSON.stringify(reporter)};
    test('portable reporter example', (context) => {
      witnessObservation(context, { marker: 'local example' });
      console.log('fixture stdout');
    });
    test('portable reporter skip', { skip: true }, () => {});
  `
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--test', '--test-reporter', reporter, fixture],
    { cwd: scratch, env: {} }
  );
  const events = stdout.trim().split('\n').map(JSON.parse);
  assert.ok(
    events.some(({ type, name }) => type === 'test:pass' && name === 'portable reporter example')
  );
  assert.ok(
    events.some(
      ({ type, name, skipped }) =>
        type === 'test:pass' && name === 'portable reporter skip' && skipped
    )
  );
  assert.deepEqual(events.find(({ type }) => type === 'observation')?.payload, {
    name: 'portable reporter example',
    observation: { marker: 'local example' },
  });
  assert.ok(
    events.some(({ type, message }) => type === 'test:stdout' && message.includes('fixture stdout'))
  );
});
