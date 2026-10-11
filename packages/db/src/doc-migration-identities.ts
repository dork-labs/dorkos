import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type MigrationEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};
export type MigrationRow = {
  rowIdentity: number;
  id: number | null;
  hash: string;
  created_at: number;
};
export const main = Object.freeze({
  idx: 148,
  version: '6',
  when: 1791478831717,
  tag: '20261008170031_session_touches',
  breakpoints: true,
  hash: '88183c88d16354ffb5472ed57e4b03e94c26b00e95bdcb22a605b3df3be995b2',
} as const);
export const docs = Object.freeze([
  Object.freeze({
    oldWhen: 1791414422000,
    when: 1791478832000,
    tag: '20261008170032_doc_room_admissions',
    hash: 'c156544a648a0d5dd48a5147f2488420d8460da5ea9e0c596afdd407486adc84',
  }),
  Object.freeze({
    oldWhen: 1791414423000,
    when: 1791478833000,
    tag: '20261008170033_doc_room_pending_sources',
    hash: '934167d31e86442927414b4ef1790e60ddc3d1d7af51285b59411d135514fc49',
  }),
  Object.freeze({
    oldWhen: 1791414424000,
    when: 1791478834000,
    tag: '20261008170034_lowly_molecule_man',
    hash: 'f85a83fc7fc5adc1764d1c10e089acdd3d0ea874139c5757bbff58ca77ed0825',
  }),
] as const);

// Root's authentic combined-schema migration identifies the reviewed Room watermark.
// Exact timestamps distinguish published150, published151 and current152 despite shared SQL.
export const consolidatedDoc: MigrationEntry & { hash: string } = Object.freeze({
  idx: 152,
  version: '6',
  when: 1791639241501,
  tag: '20261010133401_milky_jocasta',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
});
export const reportBack = Object.freeze({
  idx: 150,
  version: '6',
  when: 1791567432144,
  tag: '20261009173712_started_by_report_back',
  breakpoints: true,
  hash: 'fff2ecc577b7f440a07aace5577ba21aa0e47817616155d41b6b4f15cee99361',
} as const);
export const publishedRoom = Object.freeze({
  idx: 150,
  version: '6',
  when: 1791577212201,
  tag: '20261009202012_sleepy_killer_shrike',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
} as const);

export const publishedRoom151 = Object.freeze({
  idx: 151,
  version: '6',
  when: 1791626823308,
  tag: '20261010100703_long_shocker',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
} as const);
export const agentReports = Object.freeze({
  idx: 151,
  version: '6',
  when: 1791626094991,
  tag: '20261010095454_agent_reports_to',
  breakpoints: true,
  hash: 'a7f1de118e0678648345368108a441c4ff7d76cf8be40320eca8127b58c9fa04',
} as const);

/** Reject invalid legacy Doc migration bookkeeping with the original history error. */
export function refuse(detail: string): never {
  throw new Error(`Invalid legacy Doc migration history: ${detail}`);
}

/** Read the exact journal slot and SQL; a matching table or timestamp is never authority. */
export function reviewedSql(folder: string, expected: MigrationEntry & { hash: string }): Buffer {
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: MigrationEntry[];
  };
  const entry = journal.entries[expected.idx];
  if (
    journal.entries.filter((candidate) => candidate.idx === expected.idx).length !== 1 ||
    !entry ||
    entry.idx !== expected.idx ||
    entry.version !== expected.version ||
    entry.when !== expected.when ||
    entry.tag !== expected.tag ||
    entry.breakpoints !== expected.breakpoints
  )
    refuse('reviewed canonical journal differs');
  const bytes = readFileSync(path.join(folder, `${entry.tag}.sql`));
  if (createHash('sha256').update(bytes).digest('hex') !== expected.hash)
    refuse('reviewed canonical SQL differs');
  return bytes;
}
