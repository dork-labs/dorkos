import { describe, expect, it } from 'vitest';
import { decodeJSON, scanJSON } from '../scanner.js';
import { RunnerSchema, roles, causes, pins } from '../records.js';
import { metrics } from '../correlation.js';
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
  accounting,
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
  it('supports known progress with null cause and empty history', () => {
    const value = runner();
    value.state = 'started';
    value.rootWait = { state: 'unknown' };
    value.stdio = { state: 'open' };
    value.cancellation.cleanup = 'unknown';
    value.inventory.identities[0]!.lifetimeState = 'running';
    delete value.verifierReply;
    expect(RunnerSchema.safeParse(value).success).toBe(true);
    expect(
      RunnerSchema.safeParse({
        ...value,
        verifierReply: runner().verifierReply,
      }).success
    ).toBe(false);
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
  it('composes two correlated jobs against transaction-prefix totals', async () => {
    const f = fixture();
    const install = await deliver(
      f,
      runner('official-install', 'i'),
      descriptor('official-install', 'i')
    );
    const verifier = await deliver(
      f,
      runner('fresh-verifier', 'v', 1),
      descriptor('fresh-verifier', 'v')
    );
    const result = f.domain.compose(
      verifier.reference,
      publication(f, verifier, 'installed'),
      install.reference
    );
    expect(f.domain.project(result).kind).toBe('verified-installed');
    expect(f.domain.inspect().logicalUnits).toBe(1335296);
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
  it('retains uncertain publication and first nonzero job cause without local evidence', async () => {
    const f = fixture();
    const value = runner();
    value.rootWait = { state: 'observed', exitCode: 2 };
    value.primaryCause = 'VERIFIER_JOB_FAILED';
    delete value.verifierReply;
    const delivered = await deliver(f, value);
    const pub = publication(f, delivered);
    const dto = f.domain.project(f.domain.compose(delivered.reference, pub));
    expect(dto.kind).toBe('refused');
    expect(dto.cause).toBe('VERIFIER_JOB_FAILED');
    expect(dto.observation).toBe('unverified');
    expect('executableSHA256' in dto).toBe(false);
  });
  it.each([1, 2])('retains the first terminal issued at compose clock %s', async (entry) => {
    let armed = false;
    let calls = 0;
    let first: InstallReference | undefined;
    const f: ReturnType<typeof fixture> = fixture(() => {
      if (armed && ++calls === entry) {
        first = f.domain.failure();
      }
      return 1;
    });
    const value = runner();
    value.rootWait = { state: 'observed', exitCode: 2 };
    value.primaryCause = 'VERIFIER_JOB_FAILED';
    delete value.verifierReply;
    const delivered = await deliver(f, value);
    const pub = publication(f, delivered);
    const charged = f.domain.inspect().logicalUnits;
    armed = true;
    expect(() => f.domain.compose(delivered.reference, pub)).toThrow('PUBLICATION_BUSY');
    expect(calls).toBe(entry);
    armed = false;
    expect(first).toBeDefined();
    expect(f.domain.failure()).toBe(first);
    expect(f.domain.failure()).toBe(first);
    const dto = f.domain.project(first!);
    expect(dto.kind).toBe('uncertain');
    expect(dto.cause).toBe('VERIFIER_JOB_FAILED');
    expect(dto.accounting.cumulativeAcquisitionIntents).toBe(1);
    expect(dto.accounting.actualAcquisitions.state).toBe('unknown');
    expect(f.domain.inspect().logicalUnits).toBe(charged);
    expect(() => f.domain.compose(delivered.reference, pub)).toThrow('PUBLICATION_BUSY');
  });
  it('keeps a stable known-failure composition as the sole memoized terminal', async () => {
    const f = fixture();
    const value = runner();
    value.rootWait = { state: 'observed', exitCode: 2 };
    value.primaryCause = 'VERIFIER_JOB_FAILED';
    delete value.verifierReply;
    const delivered = await deliver(f, value);
    const result = f.domain.compose(delivered.reference, publication(f, delivered));
    expect(f.domain.project(result).kind).toBe('refused');
    expect(f.domain.project(result).cause).toBe('VERIFIER_JOB_FAILED');
    expect(f.domain.failure()).toBe(result);
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
  it('projects independently certified no-acquisition refusal without verifier evidence', async () => {
    const f = fixture();
    const value = runner();
    value.state = 'not-started';
    value.inventory.identities = [];
    value.rootWait = { state: 'not-started' };
    value.accounting = accounting(0, 0);
    value.cancellation.cleanup = 'not-required';
    value.primaryCause = 'VERIFIER_RUNNER_UNAVAILABLE';
    delete value.verifierReply;
    const delivered = await deliver(f, value);
    const dto = f.domain.project(f.domain.compose(delivered.reference, publication(f, delivered)));
    expect(dto.kind).toBe('refused');
    expect(dto.cause).toBe('VERIFIER_RUNNER_UNAVAILABLE');
    expect(dto.observation).toBe('unverified');
    expect('installationId' in dto).toBe(false);
  });
  it('rejects cancelled zero exit as success while preserving a real interruption cause', () => {
    const value = runner();
    value.cancellation.requested = true;
    expect(RunnerSchema.safeParse(value).success).toBe(false);
    value.primaryCause = 'ATTEMPT_INTERRUPTED';
    delete value.verifierReply;
    expect(RunnerSchema.safeParse(value).success).toBe(true);
  });
  it('requires a real unresolved fact and cause history for unknown state', () => {
    const value = runner();
    value.state = 'unknown';
    value.primaryCause = 'CUSTODY_UNCERTAIN';
    value.cleanupCauses = ['CUSTODY_UNCERTAIN'];
    delete value.verifierReply;
    expect(RunnerSchema.safeParse(value).success).toBe(false);
    value.stdio.state = 'unknown';
    expect(RunnerSchema.safeParse(value).success).toBe(true);
    value.cleanupCauses = [];
    expect(RunnerSchema.safeParse(value).success).toBe(false);
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
  it('terminal reuse rejects intake before any port callback', async () => {
    const f = fixture();
    const v = await deliver(f);
    const ref = f.domain.compose(v.reference, publication(f, v));
    const port = bytesPort(wire(runner()));
    await expect(f.domain.intake(v.job, {}, port, v.witness)).rejects.toThrow('PUBLICATION_BUSY');
    expect(port.reads).toBe(0);
    expect(port.closes).toBe(0);
    expect(f.domain.failure()).toBe(ref);
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
  it('successful official and verifier deliveries cover the complete final prefix', async () => {
    const f = fixture();
    const i = await deliver(
      f,
      runner('official-install', 'i'),
      descriptor('official-install', 'i')
    );
    const v = await deliver(f, runner('fresh-verifier', 'v', 1), descriptor('fresh-verifier', 'v'));
    const ref = f.domain.compose(v.reference, publication(f, v, 'installed'), i.reference);
    const dto = f.domain.project(ref);
    expect(dto.kind).toBe('verified-installed');
    expect(dto.accounting.cumulativeAcquisitionIntents).toBe(2);
    expect(dto.accounting.roleCounts['installer-root']).toEqual({
      state: 'observed',
      value: 1,
      cause: null,
    });
  });
});

describe('live transaction boundaries', () => {
  it('registration clock terminalization keeps the first authentic failure result', async () => {
    let armed = false;
    let terminal: InstallReference | undefined;
    const f: ReturnType<typeof fixture> = fixture(() => {
      if (armed) {
        armed = false;
        f.abort.abort();
        terminal = f.domain.failure();
      }
      return 1;
    });
    await deliver(f);
    armed = true;
    expect(() => f.issuer.registerJob(bounded(descriptor('official-install', 'i')))).toThrow(
      'ATTEMPT_INTERRUPTED'
    );
    expect(terminal).toBeDefined();
    expect(f.domain.failure()).toBe(terminal);
    const dto = f.domain.project(terminal!);
    expect(dto.kind).toBe('uncertain');
    expect(f.domain.project(terminal!)).toBe(dto);
  });
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
  it('registration ordering is not execution ordering: verifier registration may come first', async () => {
    const f = fixture();
    const vjob = f.issuer.registerJob(bounded(descriptor('fresh-verifier', 'v')));
    const ijob = f.issuer.registerJob(bounded(descriptor('official-install', 'i')));
    const ivalue = runner('official-install', 'i');
    const iw = f.issuer.observe(ijob, bounded(ivalue), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    const iref = await f.domain.intake(ijob, {}, bytesPort(wire(ivalue)), iw);
    const vvalue = runner('fresh-verifier', 'v', 1);
    const vw = f.issuer.observe(vjob, bounded(vvalue), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    const vref = await f.domain.intake(vjob, {}, bytesPort(wire(vvalue)), vw);
    const vp = {
      job: vjob,
      witness: vw,
      reference: vref,
      port: bytesPort(wire(vvalue)),
      value: vvalue,
    };
    const result = f.domain.compose(vref, publication(f, vp, 'installed'), iref);
    expect(f.domain.project(result).kind).toBe('verified-installed');
    expect(f.domain.project(result).accounting.cumulativeAcquisitionIntents).toBe(2);
  });
});

// Closure reflection may finish a newer same-owner observation before the outer commit.
const closure = { noLateAcquisitions: true, noAcquisition: false };
const progress = (failed = false) => {
  const value = runner();
  value.state = 'started';
  value.rootWait = { state: 'unknown' };
  value.stdio.state = 'open';
  value.cancellation.cleanup = 'unknown';
  value.inventory.identities[0]!.lifetimeState = 'running';
  delete value.verifierReply;
  if (failed) value.primaryCause = 'INSTALLATION_INVALID';
  return value;
};
const issue = (f: ReturnType<typeof fixture>, value = runner()) => {
  const job = f.issuer.registerJob(bounded(descriptor()));
  const witness = f.issuer.observe(job, bounded(value), closure);
  return { job, witness };
};
for (const withHistory of [false, true])
  it(`failed progress preserves actual cleanup history ${withHistory}`, async () => {
    const f = fixture(),
      first = progress(true);
    first.cleanupCauses = withHistory ? ['ROOT_CHANGED'] : [];
    const { job, witness } = issue(f, first);
    await f.domain.intake(job, {}, bytesPort(wire(first)), witness);
    const last = runner();
    last.primaryCause = 'INSTALLATION_INVALID';
    delete last.verifierReply;
    const w = f.issuer.observe(job, bounded(last), closure),
      ref = await f.domain.intake(job, {}, bytesPort(wire(last)), w);
    const dto = f.domain.project(
      f.domain.compose(
        ref,
        publication(f, {
          job,
          witness: w,
          reference: ref,
          port: bytesPort(wire(last)),
          value: last,
        })
      )
    );
    expect(dto.kind).toBe('refused');
    expect(dto.cause).toBe('INSTALLATION_INVALID');
    expect(dto.cleanupCauses).toEqual(withHistory ? ['ROOT_CHANGED'] : []);
  });
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
for (const nested of [false, true])
  it(`reflection observation cannot erase later metric prefix ${nested}`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor()));
    let once = nested;
    const newer = runner();
    newer.accounting.networkBytes = {
      state: 'observed',
      value: 1,
      cause: null,
    };
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
    const value = runner(),
      witness = f.issuer.observe(job, bounded(value), observedClosure),
      reference = await f.domain.intake(job, {}, bytesPort(wire(value)), witness);
    const pub = publication(f, {
      job,
      witness,
      reference,
      port: bytesPort(wire(value)),
      value,
    });
    if (nested) expect(() => f.domain.compose(reference, pub)).toThrow('INSTALLATION_INVALID');
    else expect(f.domain.project(f.domain.compose(reference, pub)).kind).toBe('verified-reused');
  });

for (const stage of ['descriptor', 'late-keys'] as const) {
  it(`newer accounting survives closure ${stage} reflection`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor())),
      value = runner();
    const newer = runner();
    newer.accounting.networkBytes = {
      state: 'observed',
      value: 1,
      cause: null,
    };
    let fired = false,
      keys = 0;
    const observeNewer = () => {
      if (!fired) {
        fired = true;
        f.issuer.observe(job, bounded(newer), closure);
      }
    };
    const observedClosure = new Proxy(
      { ...closure },
      {
        ownKeys(target) {
          if (++keys === 2 && stage === 'late-keys') observeNewer();
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          if (stage === 'descriptor') observeNewer();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );
    const witness = f.issuer.observe(job, bounded(value), observedClosure);
    const reference = await f.domain.intake(job, {}, bytesPort(wire(value)), witness);
    expect(fired).toBe(true);
    expect(() =>
      f.domain.compose(
        reference,
        publication(f, {
          job,
          witness,
          reference,
          port: bytesPort(wire(value)),
          value,
        })
      )
    ).toThrow('INSTALLATION_INVALID');
  });
}
for (const settle of [false, true]) {
  it(`cleanup history stays ordered and deduplicated after replacement ${settle}`, async () => {
    const f = fixture(),
      first = progress(true);
    first.cleanupCauses = ['ROOT_CHANGED'];
    const { job, witness } = issue(f, first);
    await f.domain.intake(job, {}, bytesPort(wire(first)), witness);
    const next = settle ? runner() : progress(true);
    next.primaryCause = 'INSTALLATION_INVALID';
    delete next.verifierReply;
    next.cleanupCauses = ['CUSTODY_UNCERTAIN', 'ROOT_CHANGED'];
    const w = f.issuer.observe(job, bounded(next), closure);
    const ref = await f.domain.intake(job, {}, bytesPort(wire(next)), w);
    if (settle) {
      const dto = f.domain.project(
        f.domain.compose(
          ref,
          publication(f, {
            job,
            witness: w,
            reference: ref,
            port: bytesPort(wire(next)),
            value: next,
          })
        )
      );
      expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED', 'CUSTODY_UNCERTAIN']);
      expect(dto.cause).toBe('INSTALLATION_INVALID');
    } else {
      const last = runner();
      last.primaryCause = 'INSTALLATION_INVALID';
      delete last.verifierReply;
      const lw = f.issuer.observe(job, bounded(last), closure);
      const lr = await f.domain.intake(job, {}, bytesPort(wire(last)), lw);
      const dto = f.domain.project(
        f.domain.compose(
          lr,
          publication(f, {
            job,
            witness: lw,
            reference: lr,
            port: bytesPort(wire(last)),
            value: last,
          })
        )
      );
      expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED', 'CUSTODY_UNCERTAIN']);
      expect(f.domain.inspect().cleanupCauses).toEqual(['ROOT_CHANGED', 'CUSTODY_UNCERTAIN']);
    }
  });
}

describe('independent cumulative observation facts', () => {
  const keys = [...metrics(runner().accounting).keys()];
  it('covers exactly all eighteen fixed accounting facts', () => expect(keys).toHaveLength(18));
  for (const key of keys) {
    for (const regress of [false, true]) {
      it(`retains independent ${key} prefix, regression ${regress}`, () => {
        const f = fixture();
        const job = f.issuer.registerJob(bounded(descriptor()));
        const high = runner();
        const low = runner();
        const observed = (value: number) => ({ state: 'observed' as const, value, cause: null });
        if (key === 'cumulativeAcquisitionIntents')
          high.accounting.cumulativeAcquisitionIntents = 2;
        else if (key === 'actualAcquisitions') {
          high.accounting = accounting(0, 2);
        } else if (key === 'distinctLifetimes' || key === 'peakActive' || key.startsWith('role:')) {
          high.accounting = accounting(0, 2);
          low.accounting = accounting(0, 2);
          high.accounting.peakActive = observed(1);
          low.accounting.peakActive = observed(1);
          if (key === 'distinctLifetimes') low.accounting.distinctLifetimes = observed(1);
          else if (key === 'peakActive') high.accounting.peakActive = observed(2);
          else {
            const role = roles.find((r) => key === `role:${r}`)!;
            if (role === 'verifier-root') {
              low.accounting.roleCounts['verifier-root'] = observed(1);
              low.accounting.roleCounts.downloader = observed(1);
            } else {
              high.accounting.roleCounts['verifier-root'] = observed(1);
              high.accounting.roleCounts[role] = observed(1);
            }
          }
        } else {
          const field = key as 'networkBytes';
          high.accounting[field] = observed(1);
        }
        expect(RunnerSchema.safeParse(high).success).toBe(true);
        expect(RunnerSchema.safeParse(low).success).toBe(true);
        expect(metrics(high.accounting).get(key)).toBeGreaterThan(
          metrics(low.accounting).get(key)!
        );
        f.issuer.observe(job, bounded(high), closure);
        const next = () => f.issuer.observe(job, bounded(regress ? low : high), closure);
        if (regress) expect(next).toThrow('INSTALLATION_INVALID');
        else expect(next).not.toThrow();
        expect(f.domain.inspect().logicalUnits).toBe(0);
      });
    }
  }
  it('retains known work even when closure observation fails', () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const high = runner();
    high.accounting.networkBytes = { state: 'observed', value: 1, cause: null };
    const broken = new Proxy(
      { ...closure },
      {
        ownKeys() {
          throw new Error('fixture closure failure');
        },
      }
    );
    expect(() => f.issuer.observe(job, bounded(high), broken)).toThrow();
    expect(() => f.issuer.observe(job, bounded(runner()), closure)).toThrow('INSTALLATION_INVALID');
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
  it('retains higher facts from a rejected mixed regression', () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const high = runner();
    high.accounting.networkBytes = { state: 'observed', value: 1, cause: null };
    f.issuer.observe(job, bounded(high), closure);
    const mixed = runner();
    mixed.accounting.registryWaits = { state: 'observed', value: 1, cause: null };
    expect(() => f.issuer.observe(job, bounded(mixed), closure)).toThrow('INSTALLATION_INVALID');
    expect(() => f.issuer.observe(job, bounded(high), closure)).toThrow('INSTALLATION_INVALID');
    expect(f.domain.inspect().logicalUnits).toBe(0);
  });
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

for (const nonzeroOuter of [false, true]) {
  it(`retains outer facts after earlier nested witness issuance ${nonzeroOuter}`, async () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const high = runner();
    if (nonzeroOuter) high.accounting.networkBytes = { state: 'observed', value: 1, cause: null };
    const low = runner();
    let nested: ReturnType<typeof f.issuer.observe> | undefined;
    let once = true;
    const observed = new Proxy(bounded(high), {
      ownKeys(target) {
        if (once) {
          once = false;
          nested = f.issuer.observe(job, bounded(low), closure);
        }
        return Reflect.ownKeys(target);
      },
    });
    f.issuer.observe(job, observed, closure);
    expect(nested).toBeDefined();
    const witness = nested!;
    const reference = await f.domain.intake(job, {}, bytesPort(wire(low)), witness);
    const compose = () =>
      f.domain.compose(
        reference,
        publication(f, { job, witness, reference, port: bytesPort(wire(low)), value: low })
      );
    if (nonzeroOuter) expect(compose).toThrow('INSTALLATION_INVALID');
    else expect(f.domain.project(compose()).kind).toBe('verified-reused');
  });
}

it('unknown observations retain already known facts before later closure failure', () => {
  const f = fixture();
  const job = f.issuer.registerJob(bounded(descriptor()));
  const high = runner();
  high.accounting.networkBytes = { state: 'observed', value: 1, cause: null };
  f.issuer.observe(job, bounded(high), closure);
  const unknown = runner();
  unknown.primaryCause = 'INSTALLATION_INVALID';
  delete unknown.verifierReply;
  unknown.accounting.networkBytes = { state: 'unknown', cause: 'CUSTODY_UNCERTAIN' };
  unknown.accounting.registryWaits = { state: 'observed', value: 1, cause: null };
  const broken = new Proxy(
    { ...closure },
    {
      ownKeys() {
        throw new Error('fixture closure failure');
      },
    }
  );
  expect(RunnerSchema.safeParse(unknown).success).toBe(true);
  expect(() => f.issuer.observe(job, bounded(unknown), broken)).toThrow();
  expect(() => f.issuer.observe(job, bounded(high), closure)).toThrow('INSTALLATION_INVALID');
  const restored = runner();
  restored.accounting.registryWaits = { state: 'observed', value: 1, cause: null };
  expect(() => f.issuer.observe(job, bounded(restored), closure)).toThrow('INSTALLATION_INVALID');
  expect(f.domain.inspect().logicalUnits).toBe(0);
});

// Exact-job independent failure facts precede fallible custody reflection and wire intake.
for (const path of ['ordinary', 'nested', 'closure-throw'] as const)
  for (const failed of [false, true])
    it(`authenticated observation history survives ${path} ${failed}`, async () => {
      const f = fixture(),
        job = f.issuer.registerJob(bounded(descriptor())),
        first = runner();
      if (failed) {
        first.primaryCause = 'VERIFIER_JOB_FAILED';
        first.rootWait = { state: 'observed', exitCode: 2 };
        first.cleanupCauses = ['ROOT_CHANGED'];
        delete first.verifierReply;
      }
      if (path === 'ordinary') f.issuer.observe(job, bounded(first), closure);
      else if (path === 'closure-throw') {
        const broken = new Proxy(
          { ...closure },
          {
            ownKeys() {
              throw Error('MOCK_CLOSURE');
            },
          }
        );
        expect(() => f.issuer.observe(job, bounded(first), broken)).toThrow();
      } else {
        let once = true;
        const source = new Proxy(bounded(runner()), {
          ownKeys(target) {
            if (once) {
              once = false;
              f.issuer.observe(job, bounded(first), closure);
            }
            return Reflect.ownKeys(target);
          },
        });
        f.issuer.observe(job, source, closure);
      }
      const value = runner(),
        witness = f.issuer.observe(job, bounded(value), closure);
      const port = bytesPort(wire(value)),
        reference = await f.domain.intake(job, {}, port, witness);
      const dto = f.domain.project(
        f.domain.compose(reference, publication(f, { job, witness, reference, port, value }))
      );
      expect(dto.kind).toBe(failed ? 'refused' : 'verified-reused');
      expect(dto.cause).toBe(failed ? 'VERIFIER_JOB_FAILED' : null);
      expect(dto.cleanupCauses).toEqual(failed ? ['ROOT_CHANGED'] : []);
      expect(dto.observation).toBe(failed ? 'unverified' : 'fresh-verifier');
      expect(port.reads).toBeGreaterThan(0);
      expect(port.closes).toBe(1);
      expect(f.domain.failure()).toBe(f.domain.failure());
    });
it('retains first independent primary and ordered cleanup without any intake', () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    a = runner(),
    b = runner();
  a.primaryCause = 'VERIFIER_JOB_FAILED';
  a.rootWait = { state: 'observed', exitCode: 2 };
  a.cleanupCauses = ['ROOT_CHANGED'];
  delete a.verifierReply;
  b.primaryCause = 'INSTALLATION_INVALID';
  b.cleanupCauses = ['CUSTODY_UNCERTAIN', 'ROOT_CHANGED'];
  delete b.verifierReply;
  f.issuer.observe(job, bounded(a), closure);
  f.issuer.observe(job, bounded(b), closure);
  f.issuer.observe(job, bounded(runner()), closure);
  const reference = f.domain.failure(),
    dto = f.domain.project(reference);
  expect(dto.kind).toBe('uncertain');
  expect(dto.cause).toBe('VERIFIER_JOB_FAILED');
  expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED', 'CUSTODY_UNCERTAIN']);
  expect(dto.accounting.cumulativeAcquisitionIntents).toBe(1);
  expect(dto.accounting.actualAcquisitions.state).toBe('unknown');
  expect(f.domain.failure()).toBe(reference);
  expect(f.domain.inspect().logicalUnits).toBe(65536);
});
it('retains parsed bound failure before unavailable closure without issuing a witness', () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    value = runner();
  value.primaryCause = 'VERIFIER_JOB_FAILED';
  value.rootWait = { state: 'observed', exitCode: 2 };
  value.cleanupCauses = ['ROOT_CHANGED'];
  delete value.verifierReply;
  const broken = new Proxy(
    { ...closure },
    {
      ownKeys() {
        throw Error('MOCK_CLOSURE');
      },
    }
  );
  expect(() => f.issuer.observe(job, bounded(value), broken)).toThrow('MOCK_CLOSURE');
  const dto = f.domain.project(f.domain.failure());
  expect(dto.cause).toBe('VERIFIER_JOB_FAILED');
  expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED']);
  expect(dto.accounting.actualAcquisitions.state).toBe('unknown');
  expect(dto.observation).toBe('unverified');
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
it('retains first primary while later owner deadline remains unknown custody evidence', () => {
  let now = 1;
  const f = fixture(() => now),
    job = f.issuer.registerJob(bounded(descriptor())),
    value = runner();
  value.primaryCause = 'VERIFIER_JOB_FAILED';
  value.rootWait = { state: 'observed', exitCode: 2 };
  value.cleanupCauses = ['ROOT_CHANGED'];
  delete value.verifierReply;
  f.issuer.observe(job, bounded(value), closure);
  const before = f.domain.inspect().logicalUnits;
  now = 100;
  expect(() => f.issuer.observe(job, bounded(runner()), closure)).toThrow('ATTEMPT_INTERRUPTED');
  const dto = f.domain.project(f.domain.failure());
  expect(dto.cause).toBe('VERIFIER_JOB_FAILED');
  expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED']);
  expect(dto.accounting.actualAcquisitions).toEqual({
    state: 'unknown',
    cause: 'ATTEMPT_INTERRUPTED',
  });
  expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
  expect(before).toBe(0);
});
it('malformed cleanup-only observation cannot invent a primary or cleanup history', async () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    value = runner();
  value.cleanupCauses = ['ROOT_CHANGED'];
  expect(() => f.issuer.observe(job, bounded(value), closure)).toThrow('INVALID_ENVELOPE');
  expect(f.domain.inspect().cause).toBeNull();
  expect(f.domain.inspect().cleanupCauses).toEqual([]);
  const good = runner(),
    witness = f.issuer.observe(job, bounded(good), closure),
    port = bytesPort(wire(good));
  const reference = await f.domain.intake(job, {}, port, witness);
  const dto = f.domain.project(
    f.domain.compose(reference, publication(f, { job, witness, reference, port, value: good }))
  );
  expect(dto.kind).toBe('verified-reused');
  expect(dto.cause).toBeNull();
});
for (const failed of [false, true])
  it(`closure-nested failure retains exact first primary ${failed}`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor())),
      first = runner();
    if (failed) {
      first.primaryCause = 'INSTALLATION_INVALID';
      first.cleanupCauses = ['ROOT_CHANGED'];
      delete first.verifierReply;
    }
    let once = true;
    const nested = new Proxy(
      { ...closure },
      {
        ownKeys(target) {
          if (once) {
            once = false;
            f.issuer.observe(job, bounded(first), closure);
          }
          return Reflect.ownKeys(target);
        },
      }
    );
    const value = runner(),
      witness = f.issuer.observe(job, bounded(value), nested),
      port = bytesPort(wire(value));
    const reference = await f.domain.intake(job, {}, port, witness);
    const dto = f.domain.project(
      f.domain.compose(reference, publication(f, { job, witness, reference, port, value }))
    );
    expect(dto.kind).toBe(failed ? 'refused' : 'verified-reused');
    expect(dto.cause).toBe(failed ? 'INSTALLATION_INVALID' : null);
    expect(dto.cleanupCauses).toEqual(failed ? ['ROOT_CHANGED'] : []);
  });
it('independent cleanup history deduplicates the closed cause vocabulary in observation order', () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor()));
  for (let repeat = 0; repeat < 2; repeat++)
    for (const cause of causes) {
      const value = runner();
      value.primaryCause = 'INSTALLATION_INVALID';
      value.cleanupCauses = [cause];
      delete value.verifierReply;
      f.issuer.observe(job, bounded(value), closure);
    }
  const dto = f.domain.project(f.domain.failure());
  expect(dto.cleanupCauses).toEqual([...causes]);
  expect(dto.cleanupCauses.length).toBeLessThanOrEqual(32);
  expect(dto.cause).toBe('INSTALLATION_INVALID');
  expect(f.domain.inspect().lostCleanupCauses).toBe(0);
  expect(f.domain.inspect().logicalUnits).toBe(65536);
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
it('later intake cleanup failure retains independent primary and actual cleanup with original end', async () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    first = runner();
  first.primaryCause = 'INSTALLATION_INVALID';
  first.cleanupCauses = ['ROOT_CHANGED'];
  delete first.verifierReply;
  f.issuer.observe(job, bounded(first), closure);
  const value = runner(),
    witness = f.issuer.observe(job, bounded(value), closure);
  const port = bytesPort(wire(value)),
    ends: number[] = [];
  port.close = async function (_delivery, end) {
    this.closes++;
    ends.push(end);
    throw Error('MOCK_CLOSE');
  };
  await expect(f.domain.intake(job, {}, port, witness)).rejects.toThrow('CUSTODY_UNCERTAIN');
  const result = f.domain.failure(),
    dto = f.domain.project(result);
  expect(dto.cause).toBe('INSTALLATION_INVALID');
  expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED', 'CUSTODY_UNCERTAIN']);
  expect(dto.accounting.actualAcquisitions).toEqual({
    state: 'unknown',
    cause: 'CUSTODY_UNCERTAIN',
  });
  expect(ends).toEqual([120]);
  expect(port.reads).toBeGreaterThan(0);
  expect(port.closes).toBe(1);
  expect(f.domain.failure()).toBe(result);
  expect(f.domain.inspect().cause).toBe('CUSTODY_UNCERTAIN');
});
it('unknown accounting remains unknown after an independently known failure and healthy later bytes', async () => {
  const f = fixture(),
    job = f.issuer.registerJob(bounded(descriptor())),
    first = runner();
  first.primaryCause = 'INSTALLATION_INVALID';
  first.cleanupCauses = ['ROOT_CHANGED'];
  first.accounting.networkBytes = { state: 'unknown', cause: 'CUSTODY_UNCERTAIN' };
  delete first.verifierReply;
  f.issuer.observe(job, bounded(first), closure);
  const value = runner(),
    witness = f.issuer.observe(job, bounded(value), closure),
    port = bytesPort(wire(value));
  const reference = await f.domain.intake(job, {}, port, witness);
  expect(() =>
    f.domain.compose(reference, publication(f, { job, witness, reference, port, value }))
  ).toThrow('INSTALLATION_INVALID');
  const dto = f.domain.project(f.domain.failure());
  expect(dto.kind).toBe('uncertain');
  expect(dto.cause).toBe('INSTALLATION_INVALID');
  expect(dto.cleanupCauses).toEqual(['ROOT_CHANGED']);
  expect(dto.accounting.networkBytes.state).toBe('unknown');
});
for (const raised of [false, true])
  it(`earlier healthy witness cannot hide known failure accounting ${raised}`, async () => {
    const f = fixture(),
      job = f.issuer.registerJob(bounded(descriptor())),
      good = runner();
    const witness = f.issuer.observe(job, bounded(good), closure),
      first = runner();
    first.primaryCause = 'INSTALLATION_INVALID';
    delete first.verifierReply;
    if (raised) first.accounting.networkBytes = { state: 'observed', value: 1, cause: null };
    f.issuer.observe(job, bounded(first), closure);
    const port = bytesPort(wire(good)),
      reference = await f.domain.intake(job, {}, port, witness);
    const pub = publication(f, { job, witness, reference, port, value: good });
    if (raised) {
      expect(() => f.domain.compose(reference, pub)).toThrow('INSTALLATION_INVALID');
      const dto = f.domain.project(f.domain.failure());
      expect(dto.cause).toBe('INSTALLATION_INVALID');
      expect(dto.accounting.networkBytes.state).toBe('unknown');
    } else {
      const dto = f.domain.project(f.domain.compose(reference, pub));
      expect(dto.kind).toBe('refused');
      expect(dto.cause).toBe('INSTALLATION_INVALID');
    }
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
  for (const stage of [
    'sourceKeys',
    'sourceDescriptor',
    'dataPrototype',
    'dataKeys',
    'dataDescriptor',
  ] as const) {
    for (const stopped of [false, true]) {
      it(`publication reflection ${stage} terminal fence ${stopped}`, async () => {
        const f = fixture();
        const result = await deliver(f, failedPublicationRunner());
        let calls = 0,
          terminal: InstallReference | undefined;
        const trigger = () => {
          if (calls++ === 0 && stopped) terminal = f.domain.failure();
        };
        const value = data(f, result);
        const proxied = new Proxy(value, {
          getPrototypeOf(target) {
            if (stage === 'dataPrototype') trigger();
            return Reflect.getPrototypeOf(target);
          },
          ownKeys(target) {
            if (stage === 'dataKeys') trigger();
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            if (stage === 'dataDescriptor') trigger();
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        const source = new Proxy(bounded(proxied), {
          ownKeys(target) {
            if (stage === 'sourceKeys') trigger();
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            if (stage === 'sourceDescriptor') trigger();
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        const units = f.domain.inspect().logicalUnits;
        if (stopped) {
          expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
          expect(f.domain.failure()).toBe(terminal);
          expect(f.domain.inspect().logicalUnits).toBe(units);
          const after = calls;
          expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
          expect(calls).toBe(after);
        } else {
          const ref = f.issuer.publication(source);
          expect(f.domain.project(f.domain.compose(result.reference, ref)).cause).toBe(
            'INSTALLATION_INVALID'
          );
          expect(f.domain.inspect().logicalUnits).toBe(units + 524288);
        }
        expect(calls).toBeGreaterThan(0);
      });
    }
  }
  for (const clockAt of [1, 2, 8]) {
    for (const stopped of [false, true]) {
      it(`publication clock ${clockAt} terminal fence ${stopped}`, async () => {
        let armed = false,
          clocks = 0,
          terminal: InstallReference | undefined;
        const f: ReturnType<typeof fixture> = fixture(() => {
          if (armed && ++clocks === clockAt && stopped) terminal = f.domain.failure();
          return 1;
        });
        const result = await deliver(f, failedPublicationRunner());
        const source = bounded(data(f, result));
        const units = f.domain.inspect().logicalUnits;
        armed = true;
        if (stopped) {
          expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
          expect(f.domain.failure()).toBe(terminal);
          expect(f.domain.inspect().logicalUnits).toBe(units);
          const before = clocks;
          expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
          expect(clocks).toBe(before);
        } else {
          const ref = f.issuer.publication(source);
          expect(f.domain.project(f.domain.compose(result.reference, ref)).cause).toBe(
            'INSTALLATION_INVALID'
          );
          expect(f.domain.inspect().logicalUnits).toBe(units + 524288);
        }
        expect(clocks).toBeGreaterThanOrEqual(clockAt);
      });
    }
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
