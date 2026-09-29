import { createHash, randomBytes } from 'node:crypto';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CommunityExportManifestV2 } from '@dorkos/shared/community-wire';
import { bufferReader } from '../archive/__tests__/archive-test-helpers.js';
import { readManifestVersion } from '../imports/archive.js';
import { ImportFailure, parseManifest } from '../imports/manifest.js';
import { ndjsonLines, parseRow } from '../imports/ndjson.js';
import {
  collectionLines,
  ICON_SOURCE_ID,
  isV2EntryName,
  openExportV2,
} from '../imports/v2-archive.js';
import { checkExportV2 } from '../imports/v2-process.js';
import type { V2Tally } from '../imports/v2-rows.js';
import { CommunityExportChannelRowSchema } from '@dorkos/shared/community-wire';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00.000Z';
const limits = { textBytes: 16 * 1024, attachmentBytes: 1024 * 1024 };
const received = new Date('2026-02-01T00:00:00.000Z');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const ndjson = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

const owner = {
  id: id(1),
  display_name: 'Ada',
  handle: 'ada',
  role: 'owner',
  active: true,
  created_at: at,
  removed_at: null,
  email: 'ada@example.test',
};
const channel = {
  id: id(10),
  name: 'general',
  description: null,
  visibility: 'public',
  archived: false,
  created_at: at,
};
const entry = (n: number, seq: number, channelId = id(10)) => ({
  id: id(100 + n),
  channel_id: channelId,
  seq,
  author_member_id: id(1),
  author_agent_id: null,
  author_display_name: 'Ada',
  text: `message ${n}`,
  mentions: [],
  parent_entry_id: null,
  thread_root_entry_id: null,
  created_at: at,
  removal: null,
});
const fileBytes = Buffer.from('hello, file');
const attachment = {
  id: id(200),
  channelId: id(10),
  entryId: id(101),
  uploaderMemberId: id(1),
  uploaderAgentId: null,
  name: 'hello.txt',
  contentType: 'text/plain',
  byteSize: fileBytes.length,
  checksum: sha(fileBytes),
  uploadedAt: at,
  archivePath: `files/${id(200)}/hello.txt`,
};

/** A small, valid version 2 owner export's pieces, which each test bends. */
function pieces() {
  const manifest: CommunityExportManifestV2 = {
    version: 2,
    scope: 'owner',
    exportId: id(900),
    requesterMemberId: id(1),
    createdAt: at,
    completedAt: at,
    community: {
      id: id(99),
      name: 'Place',
      description: null,
      admissionPolicy: 'invite_only',
      lifecycle: 'active',
      lifecycleVersion: 1,
      settingsVersion: 1,
      icon: null,
    },
    files: {
      channels: ['channels/000001.ndjson'],
      members: ['members/000001.ndjson'],
      agents: [],
      channelMembers: [],
      agentChannelMembers: [],
      auditEvents: [],
      entries: ['entries/000001.ndjson'],
      attachments: ['attachments/000001.ndjson'],
    },
    counts: {
      channels: 1,
      members: 1,
      agents: 0,
      channelMembers: 0,
      agentChannelMembers: 0,
      auditEvents: 0,
      entries: 2,
      attachments: 1,
    },
  };
  const entries: [string, Uint8Array][] = [
    ['entries/000001.ndjson', strToU8(ndjson([entry(1, 1), entry(2, 2)]))],
    ['attachments/000001.ndjson', strToU8(ndjson([attachment]))],
    [attachment.archivePath, fileBytes],
    ['channels/000001.ndjson', strToU8(ndjson([channel]))],
    ['members/000001.ndjson', strToU8(ndjson([owner]))],
  ];
  return { manifest, entries };
}

function zip(entries: [string, Uint8Array][]): Buffer {
  const chunks: Uint8Array[] = [];
  const writer = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, bytes] of entries) {
    const file = name.startsWith('files/') ? new ZipPassThrough(name) : new ZipDeflate(name);
    writer.add(file);
    file.push(bytes, true);
  }
  writer.end();
  return Buffer.concat(chunks);
}

function build(change: (p: ReturnType<typeof pieces>) => void = () => undefined): Buffer {
  const p = pieces();
  change(p);
  return zip([...p.entries, ['manifest.json', strToU8(JSON.stringify(p.manifest))]]);
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImportFailure) return error.code;
    throw error;
  }
  return 'passed';
}

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

async function lines(source: AsyncIterable<Uint8Array>, max = 64): Promise<string[]> {
  const out: string[] = [];
  for await (const line of ndjsonLines(source, max)) out.push(line.toString('utf8'));
  return out;
}

/** Check an export end to end the way the worker does, without a database. */
async function validate(bytes: Buffer): Promise<V2Tally> {
  const opened = await openExportV2(bufferReader(bytes), limits);
  return (await checkExportV2(opened, limits, received)).tally;
}

describe('NDJSON lines', () => {
  // Purpose: lines split across chunks come back whole, and every malformed shape is refused
  // rather than read as fewer or different rows.
  it('joins lines across chunks and refuses empty, unterminated, or overlong lines', async () => {
    expect(await lines(chunks('{"a"', ':1}\n{"b":2}\n'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(await lines(chunks(''))).toEqual([]);
    await expect(lines(chunks('{"a":1}\n\n'))).rejects.toMatchObject({
      code: 'IMPORT_ARCHIVE_INVALID',
    });
    await expect(lines(chunks('{"a":1}'))).rejects.toMatchObject({
      code: 'IMPORT_ARCHIVE_INVALID',
    });
    // A line is refused as soon as it passes the limit, before its end ever arrives.
    const endless = (async function* () {
      for (let index = 0; index < 1_000_000; index++) yield Buffer.alloc(16, 0x61);
      throw new Error('read past the limit');
    })();
    await expect(lines(endless)).rejects.toMatchObject({ code: 'IMPORT_ARCHIVE_INVALID' });
    expect(await lines(chunks(`${'a'.repeat(64)}\n`))).toHaveLength(1);
    await expect(lines(chunks(`${'a'.repeat(65)}\n`))).rejects.toMatchObject({
      code: 'IMPORT_ARCHIVE_INVALID',
    });
  });

  // Purpose: a row is read only through its strict schema, as valid UTF-8, with no NUL.
  it('parses a row strictly', () => {
    const line = Buffer.from(JSON.stringify(channel));
    expect(parseRow(line, CommunityExportChannelRowSchema)).toEqual(channel);
    for (const bad of [
      Buffer.from(JSON.stringify({ ...channel, extra: 1 })),
      Buffer.from(JSON.stringify({ ...channel, name: 'nul \u0000' })),
      Buffer.from([0x7b, 0xff, 0x7d]),
      Buffer.from('not json'),
    ])
      expect(() => parseRow(bad, CommunityExportChannelRowSchema)).toThrow(ImportFailure);
  });
});

describe('opening a version 2 export', () => {
  // Purpose: a well-formed export passes every check and counts what it holds.
  it('accepts a valid export', async () => {
    const tally = await validate(build());
    expect(tally.counts).toMatchObject({ channels: 1, members: 1, entries: 2, attachments: 1 });
    expect(tally.attachmentBytes).toBe(fileBytes.length);
    expect(await readManifestVersion(bufferReader(build()))).toBe(2);
  });

  const refusals: [string, (p: ReturnType<typeof pieces>) => void, string][] = [
    [
      'a name outside the version 2 layout',
      (p) => p.entries.push(['notes.txt', strToU8('x')]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a path trick',
      (p) => p.entries.push([`files/${id(201)}/../escape`, strToU8('x')]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a duplicate name',
      (p) => p.entries.push([attachment.archivePath, fileBytes]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a data file the manifest does not list',
      (p) => p.entries.push(['agents/000001.ndjson', strToU8('')]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a listed data file that is missing',
      (p) => p.manifest.files.agents.push('agents/000001.ndjson'),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a data file listed under another collection',
      (p) => {
        p.manifest.files.channels = ['members/000001.ndjson'];
        p.manifest.files.members = ['channels/000001.ndjson'];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a data file listed twice',
      (p) => p.manifest.files.channels.push('channels/000001.ndjson'),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file the attachment count leaves out',
      (p) => p.entries.push([`files/${id(201)}/extra.txt`, strToU8('x')]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an icon the manifest does not name',
      (p) => p.entries.push(['community/icon', strToU8('x')]),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a file larger than an attachment may be',
      (p) => {
        const big = Buffer.alloc(limits.attachmentBytes + 1);
        p.entries[2] = [attachment.archivePath, big];
      },
      'IMPORT_TOO_LARGE',
    ],
    [
      'a personal export',
      (p) => Object.assign(p.manifest, { scope: 'personal' }),
      'IMPORT_NOT_OWNER_EXPORT',
    ],
    ['version 3', (p) => Object.assign(p.manifest, { version: 3 }), 'IMPORT_VERSION_UNSUPPORTED'],
    [
      'a manifest field the schema does not know',
      (p) => Object.assign(p.manifest, { extra: true }),
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a count that disagrees with the rows',
      (p) => {
        p.manifest.counts.entries = 3;
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'messages out of order',
      (p) => {
        p.entries[0] = ['entries/000001.ndjson', strToU8(ndjson([entry(1, 2), entry(2, 1)]))];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a channel whose messages come back after another channel',
      (p) => {
        p.entries[0] = [
          'entries/000001.ndjson',
          strToU8(ndjson([entry(1, 1, id(11)), entry(2, 1, id(10))])),
        ];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'no active owner',
      (p) => {
        p.entries[4] = ['members/000001.ndjson', strToU8(ndjson([{ ...owner, active: false }]))];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an owner who did not make the export',
      (p) => {
        p.manifest.requesterMemberId = id(2);
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a changed file byte',
      (p) => {
        p.entries[2] = [attachment.archivePath, Buffer.from('hello, fila')];
      },
      'IMPORT_CHECKSUM_MISMATCH',
    ],
    [
      'a file shorter than its row',
      (p) => {
        p.entries[2] = [attachment.archivePath, Buffer.from('hello')];
      },
      'IMPORT_CHECKSUM_MISMATCH',
    ],
    [
      'files in a different order than their rows',
      (p) => {
        const second = { ...attachment, id: id(201), archivePath: `files/${id(201)}/b.txt` };
        p.manifest.counts.attachments = 2;
        p.entries[1] = ['attachments/000001.ndjson', strToU8(ndjson([attachment, second]))];
        p.entries.splice(2, 0, [second.archivePath, fileBytes]);
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an attachment path that names another file',
      (p) => {
        p.entries[1] = [
          'attachments/000001.ndjson',
          strToU8(ndjson([{ ...attachment, archivePath: `files/${id(201)}/hello.txt` }])),
        ];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an attachment under the icon’s id',
      (p) => {
        const icon = {
          ...attachment,
          id: ICON_SOURCE_ID,
          archivePath: `files/${ICON_SOURCE_ID}/hello.txt`,
        };
        p.entries[1] = ['attachments/000001.ndjson', strToU8(ndjson([icon]))];
        p.entries[2] = [icon.archivePath, fileBytes];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a message from the future',
      (p) => {
        p.entries[0] = [
          'entries/000001.ndjson',
          strToU8(
            ndjson([{ ...entry(1, 1), created_at: '2027-01-01T00:00:00.000Z' }, entry(2, 2)])
          ),
        ];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a message longer than this host allows',
      (p) => {
        p.entries[0] = [
          'entries/000001.ndjson',
          strToU8(
            ndjson([{ ...entry(1, 1), text: 'x'.repeat(limits.textBytes + 1) }, entry(2, 2)])
          ),
        ];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'a reply whose thread root is not its parent',
      (p) => {
        p.entries[0] = [
          'entries/000001.ndjson',
          strToU8(ndjson([entry(1, 1), { ...entry(2, 2), parent_entry_id: id(101) }])),
        ];
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
    [
      'an audit event of another community',
      (p) => {
        p.manifest.files.auditEvents = ['audit-events/000001.ndjson'];
        p.manifest.counts.auditEvents = 1;
        p.entries.push([
          'audit-events/000001.ndjson',
          strToU8(
            ndjson([
              {
                id: id(300),
                community_id: id(98),
                actor_member_id: id(1),
                actor_kind: 'member',
                action: 'channel.create',
                subject_id: null,
                prior_state: null,
                next_state: null,
                changed_fields: [],
                created_at: at,
              },
            ])
          ),
        ]);
      },
      'IMPORT_ARCHIVE_INVALID',
    ],
  ];
  for (const [label, change, code] of refusals) {
    // Purpose: each way an attacker can bend a version 2 export fails with its named code.
    it(`refuses ${label}`, async () => {
      expect(await failure(validate(build(change)))).toBe(code);
    });
  }

  // Purpose: a takedown's evidence archive (and any scope but owner) is never importable, and
  // is named as not an owner export by the scope itself, not by a schema that may learn the
  // scope later.
  it('refuses an evidence archive as not an owner export', async () => {
    for (const scope of ['evidence', 'personal', 'something-new'])
      expect(await failure(validate(build((p) => Object.assign(p.manifest, { scope }))))).toBe(
        'IMPORT_NOT_OWNER_EXPORT'
      );
    const v1 = Buffer.from(
      JSON.stringify({ version: 1, scope: 'evidence', requesterMemberId: id(1) })
    );
    expect(() => parseManifest(v1)).toThrow(
      expect.objectContaining({ code: 'IMPORT_NOT_OWNER_EXPORT' })
    );
  });

  // Purpose: an archive whose manifest version is neither 1 nor 2 is named as unsupported
  // before either version's rules run, and one with no manifest as damaged.
  it('dispatches on the manifest version', async () => {
    const v3 = build((p) => Object.assign(p.manifest, { version: 3 }));
    expect(await failure(readManifestVersion(bufferReader(v3)))).toBe('IMPORT_VERSION_UNSUPPORTED');
    const none = zip(pieces().entries);
    expect(await failure(readManifestVersion(bufferReader(none)))).toBe('IMPORT_ARCHIVE_INVALID');
    const text = build((p) => Object.assign(p.manifest, { version: '2' }));
    expect(await failure(readManifestVersion(bufferReader(text)))).toBe('IMPORT_ARCHIVE_INVALID');
    expect(isV2EntryName('entries/000001.ndjson')).toBe(true);
    expect(isV2EntryName('entries/1.ndjson')).toBe(false);
    expect(isV2EntryName(`files/${id(1)}/a/b`)).toBe(false);
  });

  // Purpose: resuming reads on from the recorded line, and a file shorter than the recorded
  // progress (the archive changed under a resumed restore) is refused.
  it('resumes a collection from a recorded line', async () => {
    const opened = await openExportV2(bufferReader(build()), limits);
    const read = [];
    for await (const line of collectionLines(opened, 'entries', 1024, { file: 0, line: 1 }))
      read.push(JSON.parse(line.bytes.toString('utf8')).id);
    expect(read).toEqual([id(102)]);
    const past = collectionLines(opened, 'entries', 1024, { file: 0, line: 5 });
    expect(
      await failure(
        (async () => {
          for await (const _line of past) {
            // Nothing to read.
          }
        })()
      )
    ).toBe('IMPORT_ARCHIVE_INVALID');
  });
});

describe('the inflation cap', () => {
  /**
   * An export whose one data file claims to inflate `ratio` times its compressed size: the
   * central directory is edited, so the claim is checked before a byte is inflated.
   */
  function claiming(ratio: number): Buffer {
    // Random bytes do not compress, so the archive is about as large as the file.
    const noise = randomBytes(100 * 1024);
    const bytes = build((p) => {
      p.entries[0] = ['entries/000001.ndjson', noise];
    });
    const name = Buffer.from('entries/000001.ndjson');
    for (let at = bytes.length - 22; at >= 0; at--) {
      if (
        bytes.readUInt32LE(at) === 0x02014b50 &&
        bytes.subarray(at + 46, at + 46 + name.length).equals(name)
      ) {
        bytes.writeUInt32LE(Math.floor(bytes.readUInt32LE(at + 20) * ratio), at + 24);
        return bytes;
      }
    }
    throw new Error('central directory record not found');
  }

  // Purpose: data near deflate's limit (here 1,000:1, a bomb) is refused as too large before it
  // is read, while 200:1 (the most repetitive agent output measured was about 164:1) is not.
  it('refuses a bomb before reading it, and not repetitive agent output', async () => {
    expect(await failure(openExportV2(bufferReader(claiming(1_000)), limits))).toBe(
      'IMPORT_TOO_LARGE'
    );
    expect(await failure(openExportV2(bufferReader(claiming(200)), limits))).not.toBe(
      'IMPORT_TOO_LARGE'
    );
  });
});
