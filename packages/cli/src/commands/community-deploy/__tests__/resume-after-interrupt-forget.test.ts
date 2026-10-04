/** DOR-2701: `--forget` retires a stopped run only once everything it made is provably gone. */
import { describe, expect, it } from 'vitest';
import { executeCommunityCreationPhase } from '../execute.js';
import {
  deleteLaunchJournal,
  readLaunchJournal,
  writeLaunchJournal,
  type LaunchJournal,
} from '../journal.js';
import { runForgetLaunch, type LaunchResourceChecks } from '../provenance/forget-launch.js';
import { formatForgetOutcome, runForgetCommand } from '../provenance/forget-command.js';
import {
  LATER,
  NAME,
  RUN_ID,
  SOON,
  STARTED,
  interruptAt,
  journalFile,
  plan,
  read,
  services,
  unprovedFind,
} from './resume-after-interrupt-fixtures.js';

describe('--forget retires a run only when everything it made is gone', () => {
  it('keeps the run, naming what is left, until the person removes it, then forgets it', async () => {
    const world = await interruptAt('tigris');
    const deps = (now: string) => ({
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: world.checks,
      now: () => now,
    });

    const kept = await runForgetLaunch(deps(LATER));
    expect(kept).toMatchObject({
      outcome: 'still-there',
      remaining: [
        { provider: 'fly', name: NAME, organization: 'personal', status: 'present' },
        { provider: 'neon', id: 'project-1', organization: 'org-old-resonance' },
      ],
    });
    const text = formatForgetOutcome(kept, RUN_ID).text;
    expect(text).toContain('They may incur charges until you remove them:');
    expect(text).toContain(`Remove: fly apps destroy ${NAME}`);
    expect(text).toContain('Remove: neonctl projects delete project-1');
    expect(await readLaunchJournal(journalFile())).not.toBeNull();

    world.world.fly = null;
    world.world.neon = null;
    // Even with both gone, a create sent moments ago could still land.
    expect(await runForgetLaunch(deps(SOON))).toMatchObject({ outcome: 'wait' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();

    expect(await runForgetLaunch(deps(LATER))).toMatchObject({ outcome: 'forgotten' });
    expect(await readLaunchJournal(journalFile())).toBeNull();
  });

  it('never forgets a run whose resources cannot be read, or whose create may have landed', async () => {
    const world = await interruptAt('neon');
    const deps = (checks: Partial<LaunchResourceChecks>) => ({
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: { ...world.checks, ...checks },
      now: () => LATER,
    });
    world.world.fly = null;
    await expect(
      runForgetLaunch(
        deps({
          flyAppGone: async () => {
            throw new Error('unreadable');
          },
        })
      )
    ).resolves.toMatchObject({ outcome: 'still-there', remaining: [{ status: 'unreadable' }] });
    // A project carrying this run's own marker, created after the window: this run's create
    // landing late. Its time alone never makes it someone else's.
    const marker = (await read()).pendingIntent!.provenanceMarker!;
    const late = unprovedFind('neon');
    if (late.kind !== 'neon') throw new Error('unreachable');
    late.projects[0] = {
      ...late.projects[0]!,
      roles: [`community_${marker}`],
      createdAt: LATER,
    };
    await expect(runForgetLaunch(deps({ findIntended: async () => late }))).resolves.toEqual({
      outcome: 'pending-create',
      provider: 'neon',
      status: 'present',
    });
    await expect(
      runForgetLaunch(
        deps({
          findIntended: async () => {
            throw new Error('unreadable');
          },
        })
      )
    ).resolves.toEqual({ outcome: 'pending-create', provider: 'neon', status: 'unreadable' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  // The review's dead end: --remove-uncertain said "--forget once they are gone", and --forget sent
  // the person back while someone else's project held the name.
  it('forgets a run whose create name is held only by a resource proved not to be its own', async () => {
    const world = await interruptAt('neon');
    world.world.fly = null;
    world.intended.found = unprovedFind('neon');
    const outcome = await runForgetLaunch({
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: world.checks,
      now: () => LATER,
    });
    expect(outcome).toMatchObject({ outcome: 'forgotten' });
    expect(await readLaunchJournal(journalFile())).toBeNull();
  });

  it('reads a bucket by name once its app is gone, and keeps the run while the name is held', async () => {
    const world = await interruptAt('tigris');
    world.world.fly = null;
    world.world.neon = null;
    // Without the app, the bucket cannot be read through it.
    world.intended.found = { kind: 'tigris', facts: null };
    world.intended.nameHeld = true;
    const deps = {
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: world.checks,
      now: () => LATER,
    };
    await expect(runForgetLaunch(deps)).resolves.toEqual({
      outcome: 'pending-create',
      provider: 'tigris',
      status: 'present',
    });
    world.intended.nameHeld = false;
    await expect(runForgetLaunch(deps)).resolves.toMatchObject({ outcome: 'forgotten' });
  });

  // A bucket is read through this run's own, marker-proved app, so a same-name bucket there in
  // "another organization" is not proof it is someone else's: the name read must still settle it.
  it("never takes a same-name bucket on the run's own app as someone else's", async () => {
    const world = await interruptAt('tigris');
    world.world.fly = null;
    world.world.neon = null;
    const flyNetwork = (await read()).provenance!.flyNetwork!;
    world.intended.found = {
      kind: 'tigris',
      facts: {
        app: { name: NAME, organization: 'personal', network: flyNetwork },
        totalCount: 1,
        addOns: [{ token: 'addon-9', name: NAME, organization: 'elsewhere', createdAt: LATER }],
      },
    };
    world.intended.nameHeld = true;
    await expect(
      runForgetLaunch({
        readJournal: () => readLaunchJournal(journalFile()),
        discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
        checks: world.checks,
        now: () => LATER,
      })
    ).resolves.toEqual({ outcome: 'pending-create', provider: 'tigris', status: 'present' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  it('never takes a failed bucket name read for a free name', async () => {
    const world = await interruptAt('tigris');
    world.world.fly = null;
    world.world.neon = null;
    world.intended.found = { kind: 'tigris', facts: null };
    await expect(
      runForgetLaunch({
        readJournal: () => readLaunchJournal(journalFile()),
        discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
        checks: {
          ...world.checks,
          tigrisNameHeld: async () => {
            throw new Error('unreadable');
          },
        },
        now: () => LATER,
      })
    ).resolves.toMatchObject({ outcome: 'pending-create', provider: 'tigris' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  it('tells the person to delete the access key of a bucket the run made (DOR-2646)', async () => {
    const world = services();
    await executeCommunityCreationPhase(plan, await read(), world.creation);
    const deps = {
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: world.checks,
      now: () => LATER,
    };
    const kept = formatForgetOutcome(await runForgetLaunch(deps), RUN_ID).text;
    expect(kept).toContain(`Remove: fly storage destroy ${NAME}`);
    expect(kept).toContain(`usually ${NAME}_access_key`);
    world.world.fly = null;
    world.world.neon = null;
    world.world.tigris = null;
    const forgotten = formatForgetOutcome(await runForgetLaunch(deps), RUN_ID);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.text).toContain('it no longer shows in --list-incomplete');
    expect(forgotten.text).toContain(
      `Tigris still has the access key Fly made for bucket ${NAME}, and it still works.`
    );
    expect(forgotten.text).toContain('tigris access-keys delete <id>');
  });

  it('never forgets a run that changed while it was being checked', async () => {
    const world = await interruptAt('neon');
    world.world.fly = null;
    const outcome = await runForgetLaunch({
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: {
        ...world.checks,
        // A --resume or --remove-uncertain writes the journal between the read and the delete.
        flyAppGone: async () => {
          const current = await read();
          await writeLaunchJournal(
            journalFile(),
            { ...current, revision: current.revision + 1 },
            current.revision
          );
          return true;
        },
      },
      now: () => LATER,
    });
    expect(outcome).toEqual({ outcome: 'changed' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  it('keeps the journal through the command when a writer lands before the delete', async () => {
    const world = await interruptAt('neon');
    world.world.fly = null;
    let printed = '';
    const code = await runForgetCommand({
      runId: RUN_ID,
      journalPath: journalFile(),
      serviceOptions: undefined as never,
      output: { write: (chunk: string) => ((printed += chunk), true) } as never,
      checks: {
        ...world.checks,
        flyAppGone: async () => {
          const current = await read();
          await writeLaunchJournal(
            journalFile(),
            { ...current, revision: current.revision + 1 },
            current.revision
          );
          return true;
        },
      },
      now: () => LATER,
    });
    expect(code).toBe(1);
    expect(printed).toContain('This run changed while DorkOS was checking it');
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  it('never forgets a run whose unresolved create has no recorded request time', async () => {
    const world = await interruptAt('neon');
    world.world.fly = null;
    const current = await read();
    const { requestedAt: _dropped, ...intent } = current.pendingIntent!;
    await writeLaunchJournal(
      journalFile(),
      { ...current, revision: current.revision + 1, pendingIntent: intent },
      current.revision
    );
    const outcome = await runForgetLaunch({
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: world.checks,
      now: () => LATER,
    });
    expect(outcome).toEqual({ outcome: 'pending-create-unprovable', provider: 'neon' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });

  it('leaves a removal in progress and a finished launch alone', async () => {
    const current = await read();
    const removing: LaunchJournal = {
      ...current,
      revision: current.revision + 1,
      pendingRemoval: {
        provider: 'fly',
        token: '4817203',
        resourceName: NAME,
        proof: 'marker',
        requestedAt: STARTED,
      },
    };
    await writeLaunchJournal(journalFile(), removing, current.revision);
    const deps = {
      readJournal: () => readLaunchJournal(journalFile()),
      discard: (expected: number) => deleteLaunchJournal(journalFile(), expected),
      checks: services().checks,
      now: () => LATER,
    };
    await expect(runForgetLaunch(deps)).resolves.toEqual({ outcome: 'removal-pending' });
    await writeLaunchJournal(
      journalFile(),
      { ...removing, revision: removing.revision + 1, pendingRemoval: null, state: 'complete' },
      removing.revision
    );
    await expect(runForgetLaunch(deps)).resolves.toEqual({ outcome: 'complete' });
    expect(await readLaunchJournal(journalFile())).not.toBeNull();
  });
});
