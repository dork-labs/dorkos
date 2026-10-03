import { describe, expect, it } from 'vitest';
import {
  RunnerSchema,
  AccountingSchema,
  LocalEvidenceSchema,
  RuntimeInstallDTOSchema,
  pins,
} from '../records.js';
import { FixtureLedger } from '../correlation.js';
import { EnvelopeOwner, reservations } from '../owner.js';
import {
  bounded,
  fixture,
  runner,
  descriptor,
  bytesPort,
  wire,
  accounting,
  deliver,
  publication,
  sha,
  reply,
} from './fixtures.js';

const prepare = (f: ReturnType<typeof fixture>, value = runner(), d = descriptor()) => {
  const job = f.issuer.registerJob(bounded(d));
  const witness = f.issuer.observe(job, bounded(value), {
    noLateAcquisitions: true,
    noAcquisition: value.state === 'not-started',
  });
  return { job, witness };
};
const expectedPublication = (
  f: ReturnType<typeof fixture>,
  r: Awaited<ReturnType<typeof deliver>>,
  path = '/fixture/root'
) => ({
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
    libraryRoot: path,
    executablePath: path + '/executable',
    ...pins,
    executableSHA256: sha('a'),
    platform: 'darwin',
    arch: 'arm64',
    verifierJobBinding: r.value.jobBinding,
    verifierEvidenceDigest: f.domain.fixtureEvidenceDigest(r.reference),
  },
});
describe('exact representation and correlation boundaries', () => {
  it('holds complete unknown phase and refuses allocation above remaining units', () => {
    const abort = new AbortController();
    const owner = new EnvelopeOwner(() => 1, 100, 120, abort.signal);
    const first = {};
    const second = {};
    owner.reserve(first, reservations.runner);
    owner.reserve(second, reservations.runner);
    expect(owner.units).toBe(reservations.total);
    expect(() => owner.reserve({}, 1)).toThrow('BUDGET_EXCEEDED');
    expect(owner.units).toBe(reservations.total);
    owner.release(first);
    expect(owner.units).toBe(reservations.runner);
    expect(() => owner.reserve({}, 1)).toThrow('BUDGET_EXCEEDED');
  });
  it('accepts both maximum-length multibyte canonical local paths in one precharged phase', async () => {
    const f = fixture();
    const r = await deliver(f);
    const data = expectedPublication(f, r);
    data.evidence.libraryRoot = '/' + '界'.repeat(4095);
    data.evidence.executablePath = '/' + '界'.repeat(4095);
    const pub = f.issuer.publication(bounded(data));
    const result = f.domain.compose(r.reference, pub);
    expect(f.domain.project(result).kind).toBe('verified-reused');
    expect(f.domain.inspect().logicalUnits).toBe(942080);
    expect(
      LocalEvidenceSchema.safeParse({
        ...data.evidence,
        libraryRoot: data.evidence.libraryRoot + 'x',
      }).success
    ).toBe(false);
  });
  it('admits maximum relative executable path and rejects traversal and absolute paths', async () => {
    const f = fixture();
    const value = runner();
    const d = descriptor();
    value.verifierReply!.candidateRelativeExecutablePath = 'a'.repeat(1024);
    d.expectedReply.candidateRelativeExecutablePath = 'a'.repeat(1024);
    const { job, witness } = prepare(f, value, d);
    await f.domain.intake(job, {}, bytesPort(wire(value)), witness);
    for (const path of [
      'a'.repeat(1025),
      '/absolute',
      'a/../b',
      'a/./b',
      'a//b',
      'C:drive',
      'a\\b',
    ])
      expect(
        RunnerSchema.safeParse({
          ...value,
          verifierReply: { ...value.verifierReply, candidateRelativeExecutablePath: path },
        }).success
      ).toBe(false);
  });
  it('checks independent exact closure and rejects a hash-correlated but uncertified settled record', async () => {
    const f = fixture();
    const value = runner();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const witness = f.issuer.observe(job, bounded(value), {
      noLateAcquisitions: false,
      noAcquisition: false,
    });
    await expect(f.domain.intake(job, {}, bytesPort(wire(value)), witness)).rejects.toThrow(
      'CUSTODY_UNCERTAIN'
    );
  });
  it('keeps an unknown metric unknown and never certifies success from arithmetic alone', async () => {
    const value = runner();
    value.accounting.networkBytes = { state: 'unknown', cause: 'DOWNLOAD_POLICY_UNSUPPORTED' };
    expect(RunnerSchema.safeParse(value).success).toBe(false);
    value.state = 'unknown';
    value.primaryCause = 'CUSTODY_UNCERTAIN';
    value.cleanupCauses = ['CUSTODY_UNCERTAIN'];
    delete value.verifierReply;
    const f = fixture();
    const delivered = await deliver(f, value);
    const dto = f.domain.project(f.domain.compose(delivered.reference, publication(f, delivered)));
    expect(dto.kind).toBe('uncertain');
    expect(dto.accounting.networkBytes.state).toBe('unknown');
    expect(dto.observation).toBe('unverified');
  });
  it('preserves prior cumulative counts across jobs and forbids a reset', async () => {
    const f = fixture();
    await deliver(f, runner('official-install', 'i'), descriptor('official-install', 'i'));
    const value = runner('fresh-verifier', 'v');
    expect(() => prepare(f, value, descriptor('fresh-verifier', 'v'))).toThrow(
      'INSTALLATION_INVALID'
    );
    expect(f.domain.inspect().logicalUnits).toBeGreaterThan(0);
  });
  it('preserves same PID/new birth and rejects reused acquisition identity', () => {
    const budgets = Object.fromEntries(
      [
        'cumulativeAcquisitionIntents',
        'actualAcquisitions',
        'distinctLifetimes',
        'peakActive',
        'networkBytes',
        'extractedBytes',
        'retainedDiagnosticBytes',
        'archiveEntries',
        'redirects',
        'officialArtifactAttempts',
        'registryWaits',
        ...[
          'installer-root',
          'downloader',
          'shell',
          'tool',
          'verifier-root',
          'version-probe',
          'other-owned',
        ].map((r) => `role:${r}`),
      ].map((key) => [key, 1000])
    );
    const ledger = new FixtureLedger(budgets);
    const i = runner('official-install', 'i');
    ledger.accept(i);
    const v = runner('fresh-verifier', 'v', 1);
    v.inventory.identities[0]!.pid = 10;
    v.inventory.identities[0]!.birth = 'new-birth';
    expect(() => ledger.accept(v)).not.toThrow();
    const bad = structuredClone(v);
    bad.inventory.identities[0]!.birth = 'third-birth';
    expect(() => ledger.accept(bad)).toThrow('OWNERSHIP_UNCERTAIN');
  });
  it('refuses counter arithmetic overflow without wrapping safe integers', () => {
    const a = accounting();
    a.cumulativeAcquisitionIntents = Number.MAX_SAFE_INTEGER + 1;
    expect(AccountingSchema.safeParse(a).success).toBe(false);
    const b = accounting();
    b.roleCounts['installer-root'] = {
      state: 'observed',
      value: Number.MAX_SAFE_INTEGER,
      cause: null,
    };
    b.roleCounts['verifier-root'] = { state: 'observed', value: 1, cause: null };
    expect(AccountingSchema.safeParse(b).success).toBe(false);
  });
  it('accepts healthy progress then a same-job settled delivery without retaining prior full snapshots', async () => {
    const f = fixture();
    const value = runner();
    value.state = 'started';
    value.rootWait = { state: 'unknown' };
    value.stdio.state = 'open';
    value.cancellation.cleanup = 'unknown';
    value.inventory.identities[0]!.lifetimeState = 'running';
    delete value.verifierReply;
    const { job, witness } = prepare(f, value);
    const prior = await f.domain.intake(job, {}, bytesPort(wire(value)), witness);
    expect(f.domain.inspect().logicalUnits).toBe(393216);
    const settled = runner();
    const finalWitness = f.issuer.observe(job, bounded(settled), {
      noLateAcquisitions: true,
      noAcquisition: false,
    });
    const final = await f.domain.intake(job, {}, bytesPort(wire(settled)), finalWitness);
    expect(f.domain.inspect().logicalUnits).toBe(417792);
    expect(() => f.domain.fixtureEvidenceDigest(prior)).toThrow('OWNERSHIP_UNCERTAIN');
    expect(f.domain.fixtureEvidenceDigest(final)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects fixed reply version/hash/current binding mismatches rather than merely hashing them', async () => {
    const f = fixture();
    const expected = runner();
    const { job, witness } = prepare(f, expected);
    const changed = runner();
    changed.verifierReply!.observedVersion = '153.0.8010.13';
    await expect(f.domain.intake(job, {}, bytesPort(wire(changed)), witness)).rejects.toThrow();
    const g = fixture();
    expect(() =>
      g.issuer.registerJob(
        bounded({
          ...descriptor(),
          expectedReply: { ...reply(), libraryDistributionSHA256: sha('b') },
        })
      )
    ).toThrow('INSTALLATION_INVALID');
  });
  it('refuses max-plus-one verifier wire while accepting exact 4096 raw reply bytes', async () => {
    for (const size of [4096, 4097]) {
      const f = fixture();
      const value = runner();
      const { job, witness } = prepare(f, value);
      const replyJSON = JSON.stringify(value.verifierReply);
      const padded = replyJSON.slice(0, -1) + ' '.repeat(size - replyJSON.length) + '}';
      const input = JSON.stringify(value).replace(replyJSON, padded);
      const promise = f.domain.intake(job, {}, bytesPort(new TextEncoder().encode(input)), witness);
      if (size === 4096) await promise;
      else await expect(promise).rejects.toThrow();
    }
  });
  it('rejects a same-binding fresh reply with the wrong pinned version before witness issuance', () => {
    const f = fixture();
    const job = f.issuer.registerJob(bounded(descriptor()));
    const value = runner();
    value.verifierReply!.observedVersion = '153.0.8010.13';
    expect(() =>
      f.issuer.observe(job, bounded(value), { noLateAcquisitions: true, noAcquisition: false })
    ).toThrow('VERIFIER_REPLY_INVALID');
  });
  it('refuses cumulative network-byte reset while preserving correct lifetime totals', async () => {
    const f = fixture();
    const installed = runner('official-install', 'i');
    installed.accounting.networkBytes = { state: 'observed', value: 10, cause: null };
    await deliver(f, installed, descriptor('official-install', 'i'));
    const verifier = runner('fresh-verifier', 'v', 1);
    expect(() => prepare(f, verifier, descriptor('fresh-verifier', 'v'))).toThrow(
      'INSTALLATION_INVALID'
    );
  });
  it('does not accept nonzero normal exit as successful verifier closure', () => {
    const value = runner();
    value.rootWait = { state: 'observed', exitCode: 9 };
    expect(RunnerSchema.safeParse(value).success).toBe(false);
  });
  it('validates strict public DTO variants without accepting paths, fake readiness or failed evidence', async () => {
    const f = fixture();
    const value = await deliver(f);
    const result = f.domain.compose(value.reference, publication(f, value));
    const dto = f.domain.project(result);
    expect(RuntimeInstallDTOSchema.safeParse(dto).success).toBe(true);
    expect(RuntimeInstallDTOSchema.safeParse({ ...dto, executablePath: '/secret' }).success).toBe(
      false
    );
    expect(
      RuntimeInstallDTOSchema.safeParse({ ...dto, readiness: { state: 'ready' } }).success
    ).toBe(false);
    expect(
      RuntimeInstallDTOSchema.safeParse({
        ...dto,
        kind: 'refused',
        cause: 'INSTALL_JOB_FAILED',
        observation: 'unverified',
      }).success
    ).toBe(false);
  });
  it('refuses publication when the frozen final composition clock sample reaches workEnd', async () => {
    // 34 was measured once on the unmutated fixture, retained in the calibration log.
    // The boundary is fixed during mutant runs rather than recomputed from changed source.
    let armed = false;
    let reads = 0;
    const f = fixture(() => (armed && ++reads === 34 ? 100 : 1));
    const value = await deliver(f);
    const pub = publication(f, value);
    armed = true;
    expect(() => f.domain.compose(value.reference, pub)).toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().cause).toBe('ATTEMPT_INTERRUPTED');
  });
  it('retains original cancellation and unknown accounting in a memoized unverified failure projection', async () => {
    const f = fixture();
    const { job, witness } = prepare(f);
    let delivery!: object;
    let settle!: (value: { count: number; eof: boolean; delivery: object }) => void;
    const port = {
      read(_target: Uint8Array, token: object) {
        delivery = token;
        return new Promise<{ count: number; eof: boolean; delivery: object }>((r) => {
          settle = r;
        });
      },
      async close(token: object) {
        return { delivery: token, state: 'closed' as const };
      },
    };
    const pending = f.domain.intake(job, {}, port, witness);
    const refusal = expect(pending).rejects.toThrow('ATTEMPT_INTERRUPTED');
    f.abort.abort();
    settle({ count: 0, eof: true, delivery });
    await refusal;
    const ref = f.domain.failure();
    expect(f.domain.failure()).toBe(ref);
    const dto = f.domain.project(ref);
    expect(dto.kind).toBe('uncertain');
    expect(dto.cause).toBe('ATTEMPT_INTERRUPTED');
    expect(dto.accounting.actualAcquisitions.state).toBe('unknown');
    expect('executableSHA256' in dto).toBe(false);
  });
});

describe('publication admission ownership', () => {
  it('stable publication issues one authentic reference and refuses every successor', async () => {
    const f = fixture(),
      v = await deliver(f),
      data = expectedPublication(f, v);
    const reference = f.issuer.publication(bounded(data));
    expect(() => f.issuer.publication(bounded(data))).toThrow('PUBLICATION_BUSY');
    expect(f.domain.project(f.domain.compose(v.reference, reference)).kind).toBe('verified-reused');
    expect(f.domain.inspect().logicalUnits).toBe(942080);
  });
  it.each([false, true])(
    'reentrant publication cannot duplicate ownership, swallowed refusal: %s',
    async (swallow) => {
      const f = fixture(),
        v = await deliver(f),
        data = expectedPublication(f, v);
      const initial = f.domain.inspect().logicalUnits;
      let attempted = 0,
        accepted = 0,
        once = true;
      const source = new Proxy(bounded(data), {
        ownKeys(target) {
          if (once) {
            once = false;
            attempted++;
            try {
              f.issuer.publication(bounded(data));
              accepted++;
            } catch (error) {
              if (!swallow) throw error;
            }
          }
          return Reflect.ownKeys(target);
        },
      });
      if (swallow) {
        const reference = f.issuer.publication(source);
        expect(f.domain.project(f.domain.compose(v.reference, reference)).kind).toBe(
          'verified-reused'
        );
        expect(f.domain.inspect().logicalUnits).toBe(initial + 524288);
      } else {
        expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
        expect(f.domain.inspect().logicalUnits).toBe(initial);
        const reference = f.issuer.publication(bounded(data));
        expect(f.domain.project(f.domain.compose(v.reference, reference)).kind).toBe(
          'verified-reused'
        );
      }
      expect(attempted).toBe(1);
      expect(accepted).toBe(0);
      expect(() => f.issuer.publication(bounded(data))).toThrow('PUBLICATION_BUSY');
    }
  );
  it.each(['throw', 'malformed'])(
    'failed publication observations release only their own phase: %s',
    async (mode) => {
      const f = fixture(),
        v = await deliver(f),
        data = expectedPublication(f, v);
      const initial = f.domain.inspect().logicalUnits;
      const source =
        mode === 'throw'
          ? new Proxy(bounded(data), {
              ownKeys() {
                throw Error('private');
              },
            })
          : bounded({ ...data, kind: 'invalid' });
      expect(() => f.issuer.publication(source)).toThrow(
        mode === 'throw' ? 'OWNERSHIP_UNCERTAIN' : 'INSTALLATION_INVALID'
      );
      expect(f.domain.inspect().logicalUnits).toBe(initial);
      const reference = f.issuer.publication(bounded(data));
      expect(f.domain.project(f.domain.compose(v.reference, reference)).kind).toBe(
        'verified-reused'
      );
    }
  );
  it('reflection retirement retains publication charge and cannot later heal ownership', async () => {
    const f = fixture(),
      v = await deliver(f),
      data = expectedPublication(f, v);
    const initial = f.domain.inspect().logicalUnits;
    const source = new Proxy(bounded(data), {
      ownKeys(target) {
        f.abort.abort();
        return Reflect.ownKeys(target);
      },
    });
    expect(() => f.issuer.publication(source)).toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().logicalUnits).toBe(initial + 524288);
    expect(() => f.issuer.publication(bounded(data))).toThrow('ATTEMPT_INTERRUPTED');
    expect(f.domain.inspect().logicalUnits).toBe(initial + 524288);
  });
  it('two-job publication fits remaining capacity and preserves job admission refusal', async () => {
    const f = fixture(),
      a = await deliver(f, runner('official-install'), descriptor('official-install'));
    const v = await deliver(
      f,
      runner('fresh-verifier', 'next', 1),
      descriptor('fresh-verifier', 'next')
    );
    const data = { ...expectedPublication(f, v), kind: 'installed' };
    const initial = f.domain.inspect().logicalUnits;
    let traversed = 0;
    const source = new Proxy(bounded(data), {
      ownKeys(target) {
        traversed++;
        return Reflect.ownKeys(target);
      },
    });
    const d = descriptor('fresh-verifier', 'third');
    expect(() => f.issuer.registerJob(bounded(d))).toThrow('PUBLICATION_BUSY');
    expect(a.reference).toBeDefined();
    expect(f.domain.inspect().logicalUnits).toBe(initial);
    const reference = f.issuer.publication(source);
    expect(traversed).toBeGreaterThan(0);
    expect(() => f.issuer.publication(source)).toThrow('PUBLICATION_BUSY');
    expect(f.domain.project(f.domain.compose(v.reference, reference, a.reference)).kind).toBe(
      'verified-installed'
    );
  });
});

it('publication reserves admission before a reentrant reserve clock observation', async () => {
  let armed = false,
    attempts = 0,
    accepted = 0;
  const f: ReturnType<typeof fixture> = fixture(() => {
    if (armed) {
      armed = false;
      attempts++;
      try {
        f.issuer.publication(bounded(data));
        accepted++;
      } catch (error) {
        expect(error).toMatchObject({ code: 'PUBLICATION_BUSY' });
      }
    }
    return 1;
  });
  const v = await deliver(f);
  const data = expectedPublication(f, v);
  armed = true;
  const reference = f.issuer.publication(bounded(data));
  expect(attempts).toBe(1);
  expect(accepted).toBe(0);
  expect(f.domain.inspect().cause).toBeNull();
  expect(f.domain.project(f.domain.compose(v.reference, reference)).kind).toBe('verified-reused');
});
