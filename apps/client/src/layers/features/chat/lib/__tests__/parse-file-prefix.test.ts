import { describe, it, expect } from 'vitest';

import { parseFilePrefix } from '../parse-file-prefix';

describe('parseFilePrefix', () => {
  it('passes through regular messages without a prefix', () => {
    const result = parseFilePrefix('Hello, how are you?');

    expect(result.files).toEqual([]);
    expect(result.textContent).toBe('Hello, how are you?');
  });

  it('extracts a single file and remaining text', () => {
    const content = [
      'Please read the following uploaded file(s):',
      '- .dork/.temp/uploads/8a3b2c1d-report.pdf',
      '',
      'Summarize this document',
    ].join('\n');

    const result = parseFilePrefix(content);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: '.dork/.temp/uploads/8a3b2c1d-report.pdf',
      displayName: 'report.pdf',
      isImage: false,
    });
    expect(result.textContent).toBe('Summarize this document');
  });

  it('extracts multiple files', () => {
    const content = [
      'Please read the following uploaded file(s):',
      '- .dork/.temp/uploads/aaaa1111-notes.txt',
      '- .dork/.temp/uploads/bbbb2222-diagram.png',
      '- .dork/.temp/uploads/cccc3333-data.csv',
      '',
      'Compare these files',
    ].join('\n');

    const result = parseFilePrefix(content);

    expect(result.files).toHaveLength(3);
    expect(result.files[0]!.displayName).toBe('notes.txt');
    expect(result.files[1]!.displayName).toBe('diagram.png');
    expect(result.files[2]!.displayName).toBe('data.csv');
    expect(result.textContent).toBe('Compare these files');
  });

  it('returns empty textContent when no text follows the prefix', () => {
    const content = [
      'Please read the following uploaded file(s):',
      '- .dork/.temp/uploads/abcd1234-file.pdf',
      '',
    ].join('\n');

    const result = parseFilePrefix(content);

    expect(result.files).toHaveLength(1);
    expect(result.textContent).toBe('');
  });

  it('strips UUID prefix from filenames', () => {
    const content = [
      'Please read the following uploaded file(s):',
      '- .dork/.temp/uploads/8a3b2c1d-screenshot.png',
      '',
      'Check this',
    ].join('\n');

    const result = parseFilePrefix(content);

    expect(result.files[0]!.displayName).toBe('screenshot.png');
  });

  it('detects image extensions correctly', () => {
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    const nonImageExts = ['pdf', 'txt', 'docx'];

    const lines = [...imageExts, ...nonImageExts].map(
      (ext, i) => `- .dork/.temp/uploads/${String(i).padStart(8, '0')}-file.${ext}`
    );

    const content = ['Please read the following uploaded file(s):', ...lines, '', 'Analyze'].join(
      '\n'
    );

    const result = parseFilePrefix(content);

    for (const file of result.files) {
      const ext = file.displayName.split('.').pop()!;
      if (imageExts.includes(ext)) {
        expect(file.isImage).toBe(true);
      } else {
        expect(file.isImage).toBe(false);
      }
    }
  });

  it('passes through text that partially matches but is not a valid prefix', () => {
    const content = 'Please read the document and summarize it.';

    const result = parseFilePrefix(content);

    expect(result.files).toEqual([]);
    expect(result.textContent).toBe(content);
  });
});
