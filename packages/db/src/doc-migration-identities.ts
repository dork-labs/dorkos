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

// Actual generated157 identity; the FK-safe additive SQL is a reviewed source correction.
// Published Room watermark rows remain separate from the canonical completion.
export const consolidatedDoc: MigrationEntry & { hash: string } = Object.freeze({
  idx: 157,
  version: '6',
  when: 1791701524866,
  tag: '20261011065204_lonely_sentinel',
  breakpoints: true,
  hash: 'b7390d7499448a3021402bd70f04c0d35096d0015e40305788e6b30fc3ce93c4',
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

/** Immutable published Room migration identity used for exact history reconciliation. */
export const publishedRoom152 = Object.freeze({
  idx: 152,
  version: '6',
  when: 1791639241501,
  tag: '20261010133401_milky_jocasta',
  breakpoints: true,
  hash: '44321f0c067d6ce35619f22ac071fcd08bdddd8dec4a7b099f8ce31998b1324f',
} as const);

/** Immutable shipped Main migration identity used for exact history reconciliation. */
export const commitments = Object.freeze({
  idx: 152,
  version: '6',
  when: 1791638862326,
  tag: '20261010132742_commitments',
  breakpoints: true,
  hash: '02b6d9816a78dbd9a2117cde805c695426c11226c61d7e21db8f5dcb2930d2c0',
} as const);

/** Immutable shipped Main migration identity used for exact history reconciliation. */
export const channelLeads = Object.freeze({
  idx: 153,
  version: '6',
  when: 1791647993524,
  tag: '20261010155953_channel_leads',
  breakpoints: true,
  hash: '6ac61a54875e70b272d9089b1b48f49942e3c2aaa25131df1a94df38ab853d7b',
} as const);

/** Immutable shipped Main migration identity used for exact history reconciliation. */
export const agentPauses = Object.freeze({
  idx: 154,
  version: '6',
  when: 1791654717694,
  tag: '20261010175157_agent_pauses',
  breakpoints: true,
  hash: 'a9bebbafc28941a7ebc1aefe7962af56ad50c1efe71968bbf6c20601f015bdde',
} as const);

/** Immutable shipped Main migration identity used for exact history reconciliation. */
export const heartbeats = Object.freeze({
  idx: 155,
  version: '6',
  when: 1791677140996,
  tag: '20261011000540_heartbeats',
  breakpoints: true,
  hash: '90488f58c9ff5ec27e464cc116ee2e9ba56ca7bfc17d34ebaa54b85d0bdd179b',
} as const);

/** Immutable shipped Main migration identity used for exact history reconciliation. */
export const remoteCommandJournal = Object.freeze({
  idx: 156,
  version: '6',
  when: 1791688446887,
  tag: '20261011031406_remote_command_journal',
  breakpoints: true,
  hash: 'f0ea5a4d2b2fb986c26031c0eb25f38335f7a4ded3280e93a0c6632c331b1bd0',
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

/** Read immutable published Room SQL from its actual retained historical location. */
export function reviewedPublishedSql(
  folder: string,
  expected: MigrationEntry & { hash: string }
): Buffer {
  const location = expected === publishedRoom152 ? folder : path.join(folder, 'legacy-doc');
  const bytes = readFileSync(path.join(location, `${expected.tag}.sql`));
  if (createHash('sha256').update(bytes).digest('hex') !== expected.hash)
    refuse('published Room SQL differs from its reviewed immutable identity');
  return bytes;
}
