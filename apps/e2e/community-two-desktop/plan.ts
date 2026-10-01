/**
 * Which journey steps a run takes, and why a remote run leaves some out.
 *
 * The local run takes every step, 1 to 29 with 15b. A remote run (a community
 * the live gate made and is holding, see `config.ts`) takes only the steps
 * that make sense on one real community whose owner and member already exist,
 * and lists every other step in its receipt as `skipped: remote-mode` with the
 * reason, so a reader can see that nothing was quietly dropped.
 *
 * @module community-two-desktop/plan
 */

/** Every step of the journey, in the order it runs. */
export const ALL_STEPS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '15b',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
] as const;

/** One step's id, the number its name starts with. */
export type StepId = (typeof ALL_STEPS)[number];

/** The steps a remote run takes. */
export const REMOTE_RUN_STEPS: readonly StepId[] = [
  '5',
  '6',
  '7',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '15b',
  '17',
  '18',
  '19',
  '20',
  '22',
  '23',
  '25',
];

const SET_UP_BY_THE_GATE =
  'The live gate already set up the community and brought the member in by invitation.';
const NEEDS_SECOND_COMMUNITY =
  'Needs a second community (Isolation Proof), and a remote run starts no community of its own.';
const CHANGES_MEMBERSHIP =
  'Changes membership (ownership, leaving, invitations, removal) on a community the gate still needs; DOR-2182 proved it locally.';

/** The steps a remote run leaves out, each with the reason its receipt gives. */
export const REMOTE_SKIPPED_STEPS: Readonly<Partial<Record<StepId, string>>> = {
  '1': SET_UP_BY_THE_GATE,
  '2': SET_UP_BY_THE_GATE,
  '3': SET_UP_BY_THE_GATE,
  '4': NEEDS_SECOND_COMMUNITY,
  '8': NEEDS_SECOND_COMMUNITY,
  '16': NEEDS_SECOND_COMMUNITY,
  '21': "Needs a private channel, which the gate's community does not have; DOR-2186 proved it locally.",
  '24': CHANGES_MEMBERSHIP,
  '26': CHANGES_MEMBERSHIP,
  '27': 'Needs to expire an invitation in the database, which a remote run cannot reach; DOR-2182 proved it locally.',
  '28': CHANGES_MEMBERSHIP,
  '29': 'Repeats step 19 after the private channel and the membership changes, none of which a remote run makes.',
};

/** Whether this run is against its own local communities or a held remote one. */
export type RunMode = 'local' | 'remote';

/**
 * Whether a run in this mode takes this step.
 *
 * @param mode - The run's mode.
 * @param id - The step's id.
 */
export function runsStep(mode: RunMode, id: StepId): boolean {
  return mode === 'local' || REMOTE_RUN_STEPS.includes(id);
}

/**
 * The id a step's name starts with (`"15b a reader scrolled up …"` → `"15b"`),
 * or `null` for a step outside the numbered journey.
 *
 * @param name - The step's name as the journey records it.
 */
export function stepIdOf(name: string): StepId | null {
  const id = /^(\d+b?)\s/.exec(name)?.[1];
  return id && (ALL_STEPS as readonly string[]).includes(id) ? (id as StepId) : null;
}

/** One step as the receipt lists it: ran (passed or failed) or skipped. */
export interface StepRecord {
  name: string;
  ok?: boolean;
  skipped?: 'remote-mode';
}

/**
 * Check that a finished run accounted for every step exactly once, either
 * run or skipped, so a step cannot drop out of the journey without a trace.
 *
 * @param mode - The run's mode.
 * @param records - The steps the run recorded, in order.
 * @throws Naming each step that is missing, repeated, or taken in the wrong mode.
 */
export function assertEveryStepAccounted(mode: RunMode, records: readonly StepRecord[]): void {
  const seen = new Map<StepId, StepRecord[]>();
  for (const record of records) {
    const id = stepIdOf(record.name);
    if (id) seen.set(id, [...(seen.get(id) ?? []), record]);
  }
  const problems: string[] = [];
  for (const id of ALL_STEPS) {
    const found = seen.get(id) ?? [];
    if (found.length !== 1) {
      problems.push(`step ${id} recorded ${found.length} times`);
      continue;
    }
    const wanted = runsStep(mode, id) ? 'ran' : 'skipped';
    const got = found[0]!.skipped ? 'skipped' : 'ran';
    if (wanted !== got) problems.push(`step ${id} ${got}, but a ${mode} run ${wanted} it`);
  }
  if (problems.length)
    throw new Error(`The journey did not account for every step: ${problems.join('; ')}`);
}
