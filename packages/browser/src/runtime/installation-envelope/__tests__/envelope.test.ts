import { describe, expect, it } from 'vitest';
import { decodeJSON, scanJSON } from '../scanner.js';
import { RunnerSchema, pins } from '../records.js';
import type { BytePort } from '../owner.js';
import { type InstallReference, type ResultReference } from '../domain.js';
import {
  fixture,
  descriptor,
  runner,
  bounded,
  bytesPort,
  wire,
  deliver,
  publication,
  sha,
} from './fixtures.js';

const check = () => {};
describe('bounded wire and closed records', () => {
  it('rejects malformed UTF-8 before parsing', () =>
    expect(() =>
      decodeJSON(new Uint8Array([123, 34, 255, 34, 58, 48, 125]), 4096, check)
    ).toThrow());
  it('rejects escaped duplicate members while accepting distinct nested members', () => {
    expect(() => scanJSON('{"a":1,"\\u0061":2}', 4096, check)).toThrow();
    expect(() => scanJSON('{"a":{"a":1},"b":2}', 4096, check)).not.toThrow();
  });
  it('admits exact depth/member/text caps and rejects plus one', () => {
    expect(() => scanJSON('['.repeat(16) + '0' + ']'.repeat(16), 4096, check)).not.toThrow();
    expect(() => scanJSON('['.repeat(17) + '0' + ']'.repeat(17), 4096, check)).toThrow();
    expect(() => scanJSON(JSON.stringify(Array(4096).fill(0)), 4096, check)).not.toThrow();
    expect(() => scanJSON(JSON.stringify(Array(4097).fill(0)), 4096, check)).toThrow();
    expect(() => scanJSON(JSON.stringify('é'.repeat(256)), 4096, check)).not.toThrow();
    expect(() => scanJSON(JSON.stringify('é'.repeat(257)), 4096, check)).toThrow();
  });
  it.each(['01', 'NaN', '1e999', '1.', '[1,]', '{"a":1,}', 'true false'])(
    'rejects invalid JSON %s',
    (input) => expect(() => scanJSON(input, 4096, check)).toThrow()
  );
  it('rejects unknown keys and zero-exit job failure causes', () => {
    expect(RunnerSchema.safeParse({ ...runner(), detail: 'secret' }).success).toBe(false);
    expect(
      RunnerSchema.safeParse({
        ...runner(),
        primaryCause: 'VERIFIER_JOB_FAILED',
        verifierReply: undefined,
      }).success
    ).toBe(false);
    const valid = runner();
    valid.rootWait = { state: 'observed', exitCode: 1 };
    valid.primaryCause = 'VERIFIER_JOB_FAILED';
    delete valid.verifierReply;
    expect(RunnerSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects duplicate lifetimes, cycles, missing parents and missing roots', () => {
    const value = runner();
    value.inventory.identities.push({ ...value.inventory.identities[0]! });
    expect(RunnerSchema.safeParse(value).success).toBe(false);
    const missing = runner();
    missing.inventory.identities[0]!.parentAcquisitionId = 'absent';
    expect(RunnerSchema.safeParse(missing).success).toBe(false);
    const cycle = runner();
    cycle.inventory.identities[0]!.parentAcquisitionId = 'verifier-root';
    expect(RunnerSchema.safeParse(cycle).success).toBe(false);
  });
});
describe('owner-authenticated fixture composition', () => {
  it('projects verified reused fixture data without paths or readiness', async () => {
    const f = fixture();
    const value = await deliver(f);
    const result = f.domain.compose(value.reference, publication(f, value));
    const dto = f.domain.project(result);
    expect(dto.kind).toBe('verified-reused');
    expect(dto.cause).toBeNull();
    expect(dto.provenance).toBe('fixture-only');
    expect(dto.readiness.state).toBe('unavailable');
    expect(JSON.stringify(dto)).not.toContain('/fixture/');
    expect(dto.observation).toBe('fresh-verifier');
    expect(f.domain.project(result)).toBe(dto);
    expect(f.domain.inspect().logicalUnits).toBe(393216 + 24576 + 524288);
  });
  it('refuses parsed, disk-shaped and public projection forgeries', async () => {
    const f = fixture();
    const value = await deliver(f);
    const pub = publication(f, value);
    expect(() =>
      f.domain.compose(JSON.parse(JSON.stringify(value.value)) as ResultReference, pub)
    ).toThrow('OWNERSHIP_UNCERTAIN');
    const result = f.domain.compose(value.reference, pub);
    expect(() => f.domain.project(f.domain.project(result) as unknown as InstallReference)).toThrow(
      'OWNERSHIP_UNCERTAIN'
    );
    expect(() => f.domain.compose(value.reference, pub)).toThrow('PUBLICATION_BUSY');
  });
  it('rejects changed final pointer after the previously held publication observation', async () => {
    const f = fixture();
    const value = await deliver(f);
    const pub = publication(f, value);
    f.issuer.replaceCurrent(sha('c'));
    expect(() => f.domain.compose(value.reference, pub)).toThrow('INSTALLATION_INVALID');
  });
  it('rejects forged witness and stale nonce before read', async () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const port = bytesPort(wire(runner()));
    await expect(f.domain.intake(job, {}, port, { fixtureWitness: true })).rejects.toThrow(
      'OWNERSHIP_UNCERTAIN'
    );
    expect(port.reads).toBe(0);
    expect(() =>
      f.issuer.observe(job, bounded(runner('fresh-verifier', 'old')), {
        noLateAcquisitions: true,
        noAcquisition: false,
      })
    ).toThrow('INSTALLATION_INVALID');
  });
  it('rejects missing port before any byte effect or phase allocation', async () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const witness = f.issuer.observe(job, bounded(runner()), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    await expect(f.domain.intake(job, {}, undefined, witness)).rejects.toThrow(
      'INSTALL_RUNNER_UNAVAILABLE'
    );
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
  it('refuses composition after an existing terminal without replacing it', async () => {
    const f = fixture();
    const value = runner();
    value.rootWait = { state: 'observed', exitCode: 2 };
    value.primaryCause = 'VERIFIER_JOB_FAILED';
    delete value.verifierReply;
    const delivered = await deliver(f, value);
    const pub = publication(f, delivered);
    const first = f.domain.failure();
    expect(() => f.domain.compose(delivered.reference, pub)).toThrow('PUBLICATION_BUSY');
    expect(f.domain.failure()).toBe(first);
  });
  it('does not disguise genuinely unknown accounting as healthy started progress', () => {
    const value = runner();
    value.state = 'started';
    value.rootWait = { state: 'unknown' };
    value.stdio.state = 'open';
    value.cancellation.cleanup = 'unknown';
    value.inventory.identities[0]!.lifetimeState = 'running';
    delete value.verifierReply;
    value.accounting.networkBytes = {
      state: 'unknown',
      cause: 'DOWNLOAD_POLICY_UNSUPPORTED',
    };
    expect(RunnerSchema.safeParse(value).success).toBe(false);
  });
});

describe('terminal admission and final verifier prefix', () => {
  it('terminal reuse rejects registration before the clock or producer observes work', async () => {
    let clocks = 0;
    const f = fixture(() => {
      clocks++;
      return 1;
    });
    const v = await deliver(f);
    const ref = f.domain.compose(v.reference, publication(f, v));
    const dto = f.domain.project(ref);
    const before = clocks;
    expect(() => f.issuer.registerJob(bounded(descriptor('official-install', 'late')))).toThrow(
      'PUBLICATION_BUSY'
    );
    expect(clocks).toBe(before);
    expect(f.domain.failure()).toBe(ref);
    expect(f.domain.project(ref)).toBe(dto);
  });
  it('pre-registered verifier cannot observe completion before official result completion', async () => {
    const f = fixture();
    const install = f.issuer.registerJob(bounded(descriptor('official-install', 'i')));
    const verifier = f.issuer.registerJob(bounded(descriptor('fresh-verifier', 'v')));
    expect(() =>
      f.issuer.observe(verifier, bounded(runner('fresh-verifier', 'v', 1)), {
        noLateAcquisitions: true,
        noAcquisition: false,
      })
    ).toThrow('INSTALLATION_INVALID');
    const value = runner('official-install', 'i');
    const witness = f.issuer.observe(install, bounded(value), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    const port = bytesPort(wire(value));
    await f.domain.intake(install, {}, port, witness);
    expect(port.reads).toBeGreaterThan(0);
    expect(() =>
      f.issuer.observe(verifier, bounded(runner('fresh-verifier', 'v', 1)), {
        noLateAcquisitions: true,
        noAcquisition: false,
      })
    ).not.toThrow();
  });
});

describe('live transaction boundaries', () => {
  it('verifier observation terminalization never publishes a witness', () => {
    let armed = false;
    const f: ReturnType<typeof fixture> = fixture(() => {
      if (armed) {
        armed = false;
        f.abort.abort();
        f.domain.failure();
      }
      return 1;
    });
    const job = f.issuer.registerJob(bounded(descriptor()));
    armed = true;
    expect(() =>
      f.issuer.observe(job, bounded(runner()), {
        noLateAcquisitions: true,
        noAcquisition: false,
      })
    ).toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.project(f.domain.failure()).kind).toBe('uncertain');
  });
  it('a fresh final observation cannot be certified by an older same-intent metric prefix', async () => {
    const f = fixture();
    const v = await deliver(f);
    const later = runner();
    later.accounting.networkBytes = {
      state: 'observed',
      value: 1,
      cause: null,
    };
    f.issuer.observe(v.job, bounded(later), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    expect(() => f.domain.compose(v.reference, publication(f, v))).toThrow('INSTALLATION_INVALID');
  });
});

// Closure reflection may finish a newer same-owner observation before the outer commit.
const closure = { noLateAcquisitions: true, noAcquisition: false };
for (const nested of [false, true])
  it(`reflection observation cannot rewind cumulative intents ${nested}`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor()));
    let once = nested;
    const newer = runner();
    newer.accounting.cumulativeAcquisitionIntents = 2;
    const observedClosure = new Proxy(
      { ...closure },
      {
        ownKeys(t) {
          if (once) {
            once = false;
            f.issuer.observe(job, bounded(newer), closure);
          }
          return Reflect.ownKeys(t);
        },
      }
    );
    const witness = f.issuer.observe(job, bounded(runner()), observedClosure);
    const port: BytePort = {
      async read() {
        throw Error('MOCK_READ');
      },
      async close(delivery) {
        return { delivery, state: 'closed' };
      },
    };
    await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('CUSTODY_UNCERTAIN');
    const dto = f.domain.project(f.domain.failure());
    expect(dto.accounting.cumulativeAcquisitionIntents).toBe(nested ? 2 : 1);
  });

describe('independent cumulative observation facts', () => {
  it('an unknown independent observation cannot be healed into verified reuse', async () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const unknown = runner();
    unknown.primaryCause = 'INSTALLATION_INVALID';
    delete unknown.verifierReply;
    unknown.accounting.networkBytes = { state: 'unknown', cause: 'CUSTODY_UNCERTAIN' };
    expect(RunnerSchema.safeParse(unknown).success).toBe(true);
    f.issuer.observe(job, bounded(unknown), closure);
    const value = runner();
    const witness = f.issuer.observe(job, bounded(value), closure);
    const reference = await f.domain.intake(job, {}, bytesPort(wire(value)), witness);
    expect(() =>
      f.domain.compose(
        reference,
        publication(f, { job, witness, reference, port: bytesPort(wire(value)), value })
      )
    ).toThrow('INSTALLATION_INVALID');
  });
});

for (const invalid of ['schema', 'binding', 'reply'] as const)
  it(`unauthenticated ${invalid} failure cannot poison ordinary success`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor())),
      value = runner();
    value.primaryCause = 'VERIFIER_JOB_FAILED';
    value.rootWait = { state: 'observed', exitCode: 2 };
    value.cleanupCauses = ['ROOT_CHANGED'];
    delete value.verifierReply;
    if (invalid === 'schema') (value as unknown as { state: string }).state = 'forged';
    if (invalid === 'binding') value.jobBinding.nonce = 'wrong';
    if (invalid === 'reply')
      value.verifierReply = {
        ...runner().verifierReply!,
        jobBinding: { ...value.jobBinding, nonce: 'wrong' },
      };
    expect(() => f.issuer.observe(job, bounded(value), closure)).toThrow();
    const good = runner(),
      witness = f.issuer.observe(job, bounded(good), closure),
      port = bytesPort(wire(good));
    const reference = await f.domain.intake(job, {}, port, witness);
    const dto = f.domain.project(
      f.domain.compose(reference, publication(f, { job, witness, reference, port, value: good }))
    );
    expect(dto.kind).toBe('verified-reused');
    expect(dto.cause).toBeNull();
    expect(dto.cleanupCauses).toEqual([]);
  });
it('known independent primary fences new job registration before producer reflection', () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    value = runner();
  value.primaryCause = 'INSTALLATION_INVALID';
  delete value.verifierReply;
  f.issuer.observe(job, bounded(value), closure);
  let reflections = 0;
  const source = new Proxy(bounded(descriptor('official-install', 'install')), {
    ownKeys(t) {
      reflections++;
      return Reflect.ownKeys(t);
    },
  });
  expect(() => f.issuer.registerJob(source)).toThrow('PUBLICATION_BUSY');
  expect(reflections).toBe(0);
  expect(f.domain.project(f.domain.failure()).cause).toBe('INSTALLATION_INVALID');
});

describe('terminal publication admission', () => {
  function failedPublicationRunner() {
    const value = runner();
    value.primaryCause = 'INSTALLATION_INVALID' as const;
    value.cleanupCauses = ['ROOT_CHANGED'];
    delete value.verifierReply;
    return value;
  }
  function data(f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof deliver>>) {
    return {
      kind: 'reused',
      state: 'complete',
      reservation: 'released',
      currentBeforeDigest: sha('8'),
      currentAfterDigest: sha('8'),
      candidateDigest: sha('6'),
      manifestDigest: sha('9'),
      evidence: {
        installationId: 'candidate',
        manifestDigest: sha('9'),
        libraryRoot: '/fixture/library',
        executablePath: '/fixture/cache/chromium',
        ...pins,
        executableSHA256: sha('a'),
        platform: 'darwin',
        arch: 'arm64',
        verifierJobBinding: result.value.jobBinding,
        verifierEvidenceDigest: f.domain.fixtureEvidenceDigest(result.reference) ?? sha('0'),
      },
    };
  }
  for (const stopped of [false, true]) {
    it(`publication entry refuses terminal before any producer or clock ${stopped}`, async () => {
      let clocks = 0,
        producerCalls = 0;
      const f = fixture(() => {
        clocks++;
        return 1;
      });
      const result = await deliver(f, failedPublicationRunner());
      const source = new Proxy(bounded(data(f, result)), {
        ownKeys(target) {
          producerCalls++;
          return Reflect.ownKeys(target);
        },
      });
      const terminal = stopped ? f.domain.failure() : undefined;
      const units = f.domain.inspect().logicalUnits,
        before = clocks;
      if (stopped) {
        expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
        expect(clocks).toBe(before);
        expect(producerCalls).toBe(0);
        expect(f.domain.inspect().logicalUnits).toBe(units);
        expect(f.domain.failure()).toBe(terminal);
      } else {
        const ref = f.issuer.publication(source);
        expect(producerCalls).toBeGreaterThan(0);
        expect(clocks).toBeGreaterThan(before);
        expect(f.domain.inspect().logicalUnits).toBe(units + 524288);
        const dto = f.domain.project(f.domain.compose(result.reference, ref));
        expect(dto.cause).toBe('INSTALLATION_INVALID');
        expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED']);
      }
    });
  }
  for (const stopped of [false, true]) {
    it(`publication final measured clock refuses terminal before token ${stopped}`, async () => {
      const prepare = async (stopAt: number) => {
        let armed = false,
          calls = 0,
          terminal: InstallReference | undefined;
        const f: ReturnType<typeof fixture> = fixture(() => {
          if (armed && ++calls === stopAt) terminal = f.domain.failure();
          return 1;
        });
        const result = await deliver(f, failedPublicationRunner());
        return {
          f,
          result,
          source: bounded(data(f, result)),
          arm: () => {
            armed = true;
          },
          calls: () => calls,
          terminal: () => terminal,
        };
      };
      const calibration = await prepare(0);
      calibration.arm();
      const measured = calibration.f.issuer.publication(calibration.source);
      const count = calibration.calls();
      expect(count).toBeGreaterThan(0);
      expect(
        calibration.f.domain.project(
          calibration.f.domain.compose(calibration.result.reference, measured)
        ).cause
      ).toBe('INSTALLATION_INVALID');
      const target = await prepare(stopped ? count : 0);
      const units = target.f.domain.inspect().logicalUnits;
      target.arm();
      if (stopped) {
        expect(() => target.f.issuer.publication(target.source)).toThrow('PUBLICATION_BUSY');
        expect(target.calls()).toBe(count);
        expect(target.f.domain.failure()).toBe(target.terminal());
        expect(target.f.domain.inspect().logicalUnits).toBe(units);
      } else {
        const ref = target.f.issuer.publication(target.source);
        expect(target.calls()).toBe(count);
        expect(
          target.f.domain.project(target.f.domain.compose(target.result.reference, ref)).cause
        ).toBe('INSTALLATION_INVALID');
        expect(target.f.domain.inspect().logicalUnits).toBe(units + 524288);
      }
    });
  }
});
