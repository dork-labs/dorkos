import { describe, it, expect } from 'vitest';
import type { QuestionItem } from '@dorkos/shared/types';
import {
  toSdkQuestionAnswers,
  mapSdkAnswersToIndices,
  parseQuestionAnswers,
} from '../question-answers.js';

const q = (question: string, header: string, multiSelect = false): QuestionItem => ({
  question,
  header,
  multiSelect,
  options: [
    { label: 'A', description: '' },
    { label: 'B', description: '' },
  ],
});

const questions: QuestionItem[] = [q('What size?', 'Size'), q('Which toppings?', 'Toppings', true)];

describe('toSdkQuestionAnswers (canonical index-keyed → SDK question-text-keyed)', () => {
  it('re-keys a single-select answer by question text', () => {
    expect(toSdkQuestionAnswers({ '0': 'Large' }, questions)).toEqual({
      'What size?': 'Large',
    });
  });

  it('passes through a comma-joined multi-select value, re-keyed by text', () => {
    expect(toSdkQuestionAnswers({ '0': 'Large', '1': 'Cheese, Onion' }, questions)).toEqual({
      'What size?': 'Large',
      'Which toppings?': 'Cheese, Onion',
    });
  });

  it('normalizes a legacy JSON-array value to comma-separated', () => {
    expect(toSdkQuestionAnswers({ '1': JSON.stringify(['Cheese', 'Onion']) }, questions)).toEqual({
      'Which toppings?': 'Cheese, Onion',
    });
  });

  it('does not reinterpret a single-select freeform answer that looks like JSON', () => {
    // Q0 is single-select — a freeform "Other" answer must reach the agent verbatim.
    expect(toSdkQuestionAnswers({ '0': '[1, 2, 3]' }, questions)).toEqual({
      'What size?': '[1, 2, 3]',
    });
  });

  it('passes non-numeric keys through unchanged (idempotent)', () => {
    expect(toSdkQuestionAnswers({ 'What size?': 'Large' }, questions)).toEqual({
      'What size?': 'Large',
    });
  });

  it('passes out-of-range indices through by their key', () => {
    expect(toSdkQuestionAnswers({ '9': 'x' }, questions)).toEqual({ '9': 'x' });
  });

  it('returns an empty object for no answers', () => {
    expect(toSdkQuestionAnswers({}, questions)).toEqual({});
  });
});

describe('mapSdkAnswersToIndices (recorded → canonical index-keyed)', () => {
  it('maps question-text-keyed answers to indices', () => {
    expect(
      mapSdkAnswersToIndices(
        { 'What size?': 'Large', 'Which toppings?': 'Cheese, Onion' },
        questions
      )
    ).toEqual({ '0': 'Large', '1': 'Cheese, Onion' });
  });

  it('falls back to legacy index keys when no question text matches', () => {
    expect(mapSdkAnswersToIndices({ '0': 'Large' }, questions)).toEqual({ '0': 'Large' });
  });

  it('drops answers whose question text is unknown', () => {
    expect(mapSdkAnswersToIndices({ 'Deleted question?': 'x' }, questions)).toEqual({});
  });
});

describe('toSdkQuestionAnswers ⇄ mapSdkAnswersToIndices round-trip', () => {
  it('preserves canonical answers across a round-trip', () => {
    const canonical = { '0': 'Large', '1': 'Cheese, Onion' };
    const sdk = toSdkQuestionAnswers(canonical, questions);
    expect(mapSdkAnswersToIndices(sdk, questions)).toEqual(canonical);
  });
});

describe('parseQuestionAnswers (tool_result text fallback)', () => {
  it('extracts "Question"="Answer" pairs into index-keyed answers', () => {
    const text =
      'Your questions have been answered: "What size?"="Large", "Which toppings?"="Cheese, Onion". You can now continue.';
    expect(parseQuestionAnswers(text, questions)).toEqual({
      '0': 'Large',
      '1': 'Cheese, Onion',
    });
  });
});
