import { describe, it, expect } from 'vitest';
import { classifyContent } from '../classify-content';

describe('classifyContent', () => {
  // JSON classification
  it('classifies a valid JSON object as json', () => {
    expect(classifyContent('{"key":"value"}')).toBe('json');
  });

  it('classifies a valid JSON array as json', () => {
    expect(classifyContent('[1,2,3]')).toBe('json');
  });

  it('classifies JSON with leading whitespace as json', () => {
    expect(classifyContent('  {"key":"value"}')).toBe('json');
  });

  it('classifies nested JSON objects as json', () => {
    expect(classifyContent('{"a":{"b":{"c":42}}}')).toBe('json');
  });

  it('classifies a string starting with { that is not valid JSON as plain', () => {
    expect(classifyContent('{ not valid json')).toBe('plain');
  });

  it('classifies partial JSON as plain', () => {
    expect(classifyContent('{"key":')).toBe('plain');
  });

  // ANSI classification
  it('classifies ANSI escape codes as ansi', () => {
    expect(classifyContent('\x1b[32mSuccess\x1b[0m')).toBe('ansi');
  });

  it('classifies ANSI bold as ansi', () => {
    expect(classifyContent('\x1b[1mBold text\x1b[0m')).toBe('ansi');
  });

  it('classifies ANSI color codes mixed with text as ansi', () => {
    expect(classifyContent('Output: \x1b[31mError\x1b[0m occurred')).toBe('ansi');
  });

  // ANSI takes priority over JSON
  it('classifies ANSI-containing JSON-like string as ansi', () => {
    expect(classifyContent('\x1b[32m{"key":"value"}\x1b[0m')).toBe('ansi');
  });

  // Plain text classification
  it('classifies plain text as plain', () => {
    expect(classifyContent('Hello, world!')).toBe('plain');
  });

  it('classifies empty string as plain', () => {
    expect(classifyContent('')).toBe('plain');
  });

  it('classifies multiline plain text as plain', () => {
    expect(classifyContent('Line one\nLine two\nLine three')).toBe('plain');
  });

  it('classifies a number string as plain', () => {
    expect(classifyContent('42')).toBe('plain');
  });
});
