/**
 * DOR-2701: a run stopped right after it saved a create intent, at each create step, against an
 * in-memory Fly, Neon and Tigris. The create never reaches the service, as when Control-C lands
 * between "intent saved" and the request. Before this fix, a run that had made anything earlier
 * could never be resumed, and `--remove-uncertain` left it stuck.
 */
import { describe, expect, it, vi } from 'vitest';
import { CommunityCreationUncertainError, executeCommunityCreationPhase } from '../execute.js';
import { readLaunchJournal, writeLaunchJournal } from '../journal.js';
import { formatRemovalOutcome } from '../provenance/removal-output.js';
import {
  DONE,
  LATER,
  NAME,
  RUN_ID,
  SOON,
  STEPS,
  interruptAt,
  journalFile,
  plan,
  read,
  removal,
  unprovedFind,
} from './resume-after-interrupt-fixtures.js';

describe('a run stopped right after it saved a create intent (DOR-2701)', () => {
  it.each(STEPS)(
    'continues from the %s step once that create provably never landed, keeping every earlier resource',
    async (service) => {
      const world = await interruptAt(service);
      const stopped = await read();
      const earlier = STEPS.slice(0, STEPS.indexOf(service));
      expect(stopped).toMatchObject({
        state: 'uncertain',
        pendingIntent: { provider: service },
        completedSteps: ['planned', ...earlier.map((step) => DONE[step])],
        lastSafeError: { code: 'CREATION_OUTCOME_UNCERTAIN' },
      });
      const earlierResources = { ...stopped.resources };
      expect(Object.keys(earlierResources)).toEqual(
        expect.arrayContaining(
          earlier.map(
            (step) => ({ fly: 'flyAppId', neon: 'neonProjectId', tigris: 'tigrisBucketId' })[step]
          )
        )
      );

      // A resume still refuses on its own: only the proof below may release the intent.
      await expect(
        executeCommunityCreationPhase(plan, stopped, world.creation)
      ).rejects.toBeInstanceOf(CommunityCreationUncertainError);

      const outcome = await removal(world.probe(), LATER);
      if (earlier.length === 0) {
        // Nothing else was made, so the run is cleared and a fresh launch starts over (DOR-2656).
        expect(outcome).toEqual({ outcome: 'absent', provider: 'fly', cleared: true });
        expect(await readLaunchJournal(journalFile())).toBeNull();
        return;
      }
      expect(outcome).toEqual({
        outcome: 'absent',
        provider: service,
        cleared: false,
        released: true,
      });
      const released = await read();
      expect(released).toMatchObject({
        state: DONE[earlier.at(-1)!],
        pendingIntent: null,
        lastSafeError: null,
        resources: earlierResources,
        completedSteps: stopped.completedSteps,
      });

      const finished = await executeCommunityCreationPhase(plan, released, world.creation);
      expect(finished.completedSteps).toEqual([
        'planned',
        'fly_app_created',
        'neon_project_created',
        'bucket_created',
      ]);
      expect(finished.resources).toMatchObject(earlierResources);
      expect(finished.pendingIntent).toBeNull();
      // Every earlier create ran once, in the first launch; the interrupted one ran again.
      for (const step of earlier) expect(world[step].create).toHaveBeenCalledOnce();
      expect(world[service].create).toHaveBeenCalledTimes(2);
      expect(world.world).toEqual({ fly: NAME, neon: 'project-1', tigris: 'addon-1' });
    }
  );

  it.each(STEPS)(
    'refuses to release the %s intent when the create is not provably absent',
    async (service) => {
      const world = await interruptAt(service);
      const stopped = await read();
      const outcomes = [
        // Something with the name exists and does not carry this run's marker.
        await removal(
          world.probe(() => unprovedFind(service)),
          LATER
        ),
        // A failed read is never taken for "absent".
        await removal(
          world.probe(() => {
            throw new Error('server error');
          }),
          LATER
        ),
        // Absent, but too recently to rule out a late landing.
        await removal(world.probe(), SOON),
      ];
      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'unproved',
        'unreachable',
        'absent',
      ]);
      expect(outcomes[2]).toMatchObject({ cleared: false, clearableAfter: expect.any(String) });
      expect(outcomes[2]).not.toHaveProperty('released');
      expect(await read()).toEqual(stopped);
      await expect(
        executeCommunityCreationPhase(plan, stopped, world.creation)
      ).rejects.toBeInstanceOf(CommunityCreationUncertainError);
      expect(world[service].create).toHaveBeenCalledOnce();

      // When it cannot finish, it names everything the run made, where, and how to remove it.
      const text = formatRemovalOutcome(outcomes[0]!, {
        runId: RUN_ID,
        journal: stopped,
        resumeCommand: null,
        recovery: '',
      }).text;
      if (service !== 'fly') {
        // Offered as the way to give up, not as the way forward.
        expect(text).toContain(
          'If you’d rather give up on this run, remove what it made. These may incur charges until you do:'
        );
        expect(text).toContain(`Fly app ${NAME}, in Fly organization personal`);
        expect(text).toContain(`Remove: fly apps destroy ${NAME}`);
        expect(text).toContain(
          `Then stop listing this run: dorkos community deploy --forget ${RUN_ID}`
        );
      }
      if (service === 'tigris') {
        expect(text).toContain(
          `Neon project ${NAME} (project id project-1), in Neon organization org-old-resonance`
        );
        expect(text).toContain('Remove: neonctl projects delete project-1');
      }
    }
  );
});

describe('releasing an intent under a concurrent writer', () => {
  it('never releases the intent when the journal changed after the verdict was read', async () => {
    const world = await interruptAt('neon');
    const probe = world.probe();
    vi.mocked(probe.find).mockImplementationOnce(async () => {
      // A --resume writes between the verdict's read and the release.
      const current = await read();
      await writeLaunchJournal(
        journalFile(),
        { ...current, revision: current.revision + 1 },
        current.revision
      );
      return { kind: 'absent' };
    });
    await expect(removal(probe, LATER)).resolves.toEqual({ outcome: 'changed' });
    expect(await read()).toMatchObject({
      state: 'uncertain',
      pendingIntent: { provider: 'neon' },
    });
  });
});
