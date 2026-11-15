/**
 * DOR-4394, Security's review of #3759: the prompt DorkOS hands OpenCode never
 * names an agent, a command subtask or a `tools` switch. Each would pick or
 * widen what runs past the session's asks, so the body carries only text
 * parts, DorkOS's system text and the model.
 */
import { describe, expect, it } from 'vitest';
import { openCodeTurnBody } from '../turn-input.js';

const MODEL = { providerID: 'fake', modelID: 'm' };

describe('what a turn hands OpenCode (DOR-4394)', () => {
  it('carries only parts, system text and the model, never agent, command or tools', () => {
    const body = openCodeTurnBody(
      'Add the totals for Northwind.',
      { systemPromptAppend: 'Kestrel’s notes.', additionalContext: [] },
      'DorkOS context',
      undefined,
      MODEL
    );
    expect(Object.keys(body).sort()).toEqual(['model', 'parts', 'system']);
    expect(body).not.toHaveProperty('agent');
    expect(body).not.toHaveProperty('command');
    expect(body).not.toHaveProperty('tools');
  });

  it('sends every part as text, never an agent mention or a subtask', () => {
    const body = openCodeTurnBody(
      '@build run the totals, then /review it',
      undefined,
      undefined,
      undefined,
      MODEL
    );
    expect(body.parts.map((part) => part.type)).toEqual(body.parts.map(() => 'text'));
    // The words reach the model as words: nothing turns `@build` into an agent part.
    expect(body.parts.at(-1)?.text).toBe('@build run the totals, then /review it');
  });
});
