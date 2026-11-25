/**
 * A person's to-do writes kept the hand routes' sentences when they moved onto the capability
 * mount (DOR-4978): every sentence the to-do services refuse with reaches the person as written,
 * through the fixed refusal table. A new sentence in a service fails here until the table lists it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toolRefusalProblem } from '../../../routes/capability-refusals.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { TodoPromiseError, type TodoPromiseErrorCode } from '../todo-promise-types.js';
import { throwTodoRefusal } from '../todo-refusals.js';

/** The services a person's writes reach. */
const SOURCES = ['../todo-service.ts', '../todo-promise-service.ts', '../notice/todo-confirm.ts'];

/** Every plain sentence a source refuses with, and its code; templates are checked below. */
function refusalsIn(file: string): Array<[TodoPromiseErrorCode, string]> {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
  const found: Array<[TodoPromiseErrorCode, string]> = [];
  for (const match of source.matchAll(/TodoPromiseError\(\s*'([A-Z_]+)',\s*(['"])(.*?)\2\s*\)/gs)) {
    found.push([match[1] as TodoPromiseErrorCode, match[3]!]);
  }
  for (const match of source.matchAll(/this\.require\(\s*[^;]*?,\s*(['"])(.*?)\1\s*\)/gs)) {
    found.push(['NOT_YOURS', match[2]!]);
  }
  return found;
}

/** What the person reads for a service's refusal. */
function detailOf(code: TodoPromiseErrorCode, sentence: string): string {
  try {
    throwTodoRefusal(new TodoPromiseError(code, sentence));
  } catch (err) {
    if (err instanceof CapabilityToolError) return toolRefusalProblem(err.payload).detail ?? '';
  }
  throw new Error('no tool error');
}

describe('a person’s to-do refusals over HTTP', () => {
  const refusals = SOURCES.flatMap(refusalsIn);

  it('finds the services’ sentences', () => {
    expect(refusals.length).toBeGreaterThan(20);
  });

  it.each(refusals)('%s says “%s” as written', (code, sentence) => {
    expect(detailOf(code, sentence)).toBe(sentence);
  });

  it('says the sentences the services build from a state as written too', () => {
    expect(detailOf('CONFLICT', 'That to-do is kept now, not open. Nothing changed.')).toBe(
      'That to-do is kept now, not open. Nothing changed.'
    );
    expect(detailOf('NOTHING_TO_CHANGE', 'That promise is already dropped.')).toBe(
      'That promise is already dropped.'
    );
  });

  it('never sends a sentence the table does not list', () => {
    expect(detailOf('NOT_YOURS', 'Made-up words from somewhere else.')).toBe(
      'This caller isn’t allowed to change that to-do.'
    );
  });
});
