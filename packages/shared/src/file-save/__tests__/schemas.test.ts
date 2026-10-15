import { expect, it } from 'vitest';
import { CanvasDocIncarnationSchema } from '../../canvas-doc-incarnation.js';
import { WriteFileRequestSchema, FileDocumentSaveReceiptSchema } from '../schemas.js';

const incarnation = {
  v: 1 as const,
  documentId: 'document-a',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const documentSave = {
  documentId: 'document-a',
  eventId: '10000000-0000-4000-8000-000000000001',
  incarnation,
};

it('preserves plain-save compatibility while receipt requests require a content baseline', () => {
  const plain = { cwd: '/owned', path: 'document.md', content: 'edited' };
  expect(WriteFileRequestSchema.parse(plain)).toEqual(plain);
  expect(WriteFileRequestSchema.safeParse({ ...plain, documentSave }).success).toBe(false);
  expect(
    WriteFileRequestSchema.parse({ ...plain, expectedContent: '', documentSave }).documentSave
  ).toEqual(documentSave);
});

it('a receipt request cannot name one document while presenting another document birth', () => {
  expect(
    WriteFileRequestSchema.safeParse({
      cwd: '/owned',
      path: 'document.md',
      content: 'edited',
      expectedContent: '',
      documentSave: { ...documentSave, documentId: 'document-b' },
    }).success
  ).toBe(false);
});

it('an accepted receipt must keep its document and birth bound together', () => {
  const receipt = {
    ...documentSave,
    docSeq: 1,
    fileHash: 'b'.repeat(64),
    status: 'accepted' as const,
  };
  expect(FileDocumentSaveReceiptSchema.parse(receipt)).toEqual(receipt);
  expect(
    FileDocumentSaveReceiptSchema.safeParse({ ...receipt, documentId: 'document-b' }).success
  ).toBe(false);
});

it.each([
  { label: 'lowercase hexadecimal', generation: 'a'.repeat(64) },
  { label: 'mixed digits and lowercase', generation: '0123456789abcdef'.repeat(4) },
  { label: 'uppercase hexadecimal', generation: 'A'.repeat(64) },
  { label: 'short hash', generation: 'a'.repeat(63) },
  { label: 'long hash', generation: 'a'.repeat(65) },
  { label: 'non-hexadecimal', generation: 'g'.repeat(64) },
])(
  'keeps receipt generation validation aligned with the neutral birth schema: $label',
  ({ generation }) => {
    const birth = { ...incarnation, generation };
    const expected = CanvasDocIncarnationSchema.safeParse(birth).success;
    const request = {
      cwd: '/owned',
      path: 'document.md',
      content: 'edited',
      expectedContent: '',
      documentSave: { ...documentSave, incarnation: birth },
    };
    const receipt = {
      ...documentSave,
      incarnation: birth,
      docSeq: 1,
      fileHash: 'b'.repeat(64),
      status: 'accepted',
    };
    expect(WriteFileRequestSchema.safeParse(request).success).toBe(expected);
    expect(FileDocumentSaveReceiptSchema.safeParse(receipt).success).toBe(expected);
  }
);
