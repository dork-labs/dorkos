import { createHash } from 'node:crypto';
import { FILE_LIMITS } from '../../../../config/constants.js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';

export interface CheckboxByteRequest {
  line: number;
  textHash: string;
  expectedFileVersion: string;
  done: boolean;
}

export interface CheckboxByteEdit {
  before: Buffer;
  after: Buffer;
  beforeHash: string;
  afterHash: string;
  lineHash: string;
  markerOffset: number;
  changed: boolean;
}

/** SHA256 of exact persisted bytes; callers must never normalize line endings. */
export function rawByteHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Prepare one parser-proven GFM marker edit without filesystem or authority effects. */
export function prepareCheckboxBytes(
  bytes: Buffer,
  request: CheckboxByteRequest,
  maxBytes = FILE_LIMITS.MAX_TEXT_FILE_BYTES
): CheckboxByteEdit {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FILE_LIMITS.MAX_TEXT_FILE_BYTES ||
    bytes.length > maxBytes
  ) {
    throw new Error('Checkbox file exceeds byte limit');
  }
  if (
    !Number.isSafeInteger(request.line) ||
    request.line < 1 ||
    typeof request.done !== 'boolean'
  ) {
    throw new Error('Invalid checkbox request');
  }
  const before = Buffer.from(bytes);
  const beforeHash = rawByteHash(before);
  if (beforeHash !== request.expectedFileVersion) throw new Error('Checkbox file version conflict');
  // Preserve BOM in the byte hashes, but remove it only from parser input.
  const bom = before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    before.subarray(bom)
  );
  if (source.includes('\0')) throw new Error('Unsupported checkbox file encoding');
  // The raw file cap bounds parser input. The node cap below bounds traversal
  // after parsing; it does not limit allocations inside the Markdown parser.
  const tree = fromMarkdown(source, {
    extensions: [frontmatter(['yaml', 'toml']), gfmTaskListItem()],
    mdastExtensions: [frontmatterFromMarkdown(['yaml', 'toml']), gfmTaskListItemFromMarkdown()],
  });
  if (
    /^(?:---|\+\+\+)[ \t]*(?:\r\n|\r|\n|$)/.test(source) &&
    !new Set(['yaml', 'toml']).has(tree.children[0]?.type ?? '')
  ) {
    throw new Error('Unmapped frontmatter syntax');
  }
  const offsets: number[] = [];
  const pending: Array<typeof tree | (typeof tree.children)[number]> = [tree];
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (++visited > 100_000) throw new Error('Checkbox parse exceeds node limit');
    if (
      node.type === 'listItem' &&
      typeof node.checked === 'boolean' &&
      node.position?.start.line === request.line
    ) {
      const start = node.position.start.offset;
      if (start === undefined) throw new Error('Unmapped checkbox syntax');
      const marker = /^(?:[*+-]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|\r|\n|$)/.exec(
        source.slice(start)
      );
      if (!marker) throw new Error('Unmapped checkbox syntax');
      const charOffset = start + marker[0].lastIndexOf('[') + 1;
      offsets.push(bom + Buffer.byteLength(source.slice(0, charOffset), 'utf8'));
    }
    if ('children' in node) for (const child of node.children) pending.push(child);
  }
  if (offsets.length !== 1) throw new Error('Checkbox line is not one supported task marker');
  const markerOffset = offsets[0]!;
  let lineStart = markerOffset;
  while (lineStart > 0 && before[lineStart - 1] !== 10 && before[lineStart - 1] !== 13) lineStart--;
  let lineEnd = markerOffset;
  while (lineEnd < before.length && before[lineEnd] !== 10 && before[lineEnd] !== 13) lineEnd++;
  const lineHash = rawByteHash(before.subarray(lineStart, lineEnd));
  if (lineHash !== request.textHash) throw new Error('Checkbox line hash conflict');
  const checked = before[markerOffset] !== 32;
  const after = Buffer.from(before);
  if (checked !== request.done) after[markerOffset] = request.done ? 120 : 32;
  return {
    before,
    after,
    beforeHash,
    afterHash: rawByteHash(after),
    lineHash,
    markerOffset,
    changed: checked !== request.done,
  };
}
