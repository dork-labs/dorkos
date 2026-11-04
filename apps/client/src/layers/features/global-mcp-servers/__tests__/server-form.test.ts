import { splitArgs } from '@dorkos/shared/global-mcp-schemas';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SERVER_FORM,
  rowIsSecret,
  serverFormProblem,
  serverInputFrom,
  type FieldRow,
  type ServerForm,
} from '../lib/server-form';

const row = (name: string, value = 'made-up', marked = false): FieldRow => ({
  id: name,
  name,
  value,
  marked,
});

const commandForm = (over: Partial<ServerForm> = {}): ServerForm => ({
  ...EMPTY_SERVER_FORM,
  name: 'made-up',
  command: 'npx',
  ...over,
});

describe('splitArgs', () => {
  it('splits on spaces and keeps quoted words whole', () => {
    expect(splitArgs('  -y   made-up@1.2.3 ')).toEqual(['-y', 'made-up@1.2.3']);
    expect(splitArgs(`--title "a b" 'c d'`)).toEqual(['--title', 'a b', 'c d']);
    expect(splitArgs('--title="a b"')).toEqual(['--title=a b']);
  });

  it('keeps a quote with no end as part of its word, and an empty line is nothing', () => {
    expect(splitArgs('it"s')).toEqual(['it"s']);
    expect(splitArgs('   ')).toEqual([]);
  });
});

describe('rowIsSecret', () => {
  it('a name matching the rule is secret even when not marked', () => {
    expect(rowIsSecret(row('MADE_UP_TOKEN'))).toBe(true);
  });

  it('any other name is secret only when marked', () => {
    expect(rowIsSecret(row('MADE_UP_SETTING'))).toBe(false);
    expect(rowIsSecret(row('MADE_UP_SETTING', 'x', true))).toBe(true);
  });
});

describe('serverFormProblem', () => {
  it('passes a finished form', () => {
    expect(serverFormProblem(commandForm())).toBeNull();
  });

  it('says what to fix, top to bottom', () => {
    expect(serverFormProblem(commandForm({ name: 'has spaces' }))?.field).toBe('name');
    expect(serverFormProblem(commandForm({ command: ' ' }))?.field).toBe('command');
    expect(serverFormProblem(commandForm({ kind: 'url', url: 'not an address' }))?.field).toBe(
      'url'
    );
  });

  it.each(['ftp://mcp.example.test', 'http:user:made-up@mcp.example.test', 'javascript:alert(1)'])(
    'takes only an address starting https:// or http://, not %s',
    (url) => {
      expect(serverFormProblem(commandForm({ kind: 'url', url }))?.field).toBe('url');
    }
  );

  it('says when the arguments are too long, before the server would', () => {
    expect(serverFormProblem(commandForm({ args: 'a'.repeat(5000) }))).toEqual({
      field: 'args',
      message: 'Those arguments are too long.',
    });
  });

  it('asks for a secret’s value, and a name for a value', () => {
    expect(serverFormProblem(commandForm({ env: [row('MADE_UP_KEY', '')] }))?.message).toContain(
      'MADE_UP_KEY'
    );
    expect(serverFormProblem(commandForm({ env: [row('', 'value')] }))?.message).toBe(
      'Name each value.'
    );
    expect(serverFormProblem(commandForm({ env: [row('A'), row('A')] }))?.message).toBe(
      'A is there twice.'
    );
  });

  it('a row with nothing in it is ignored', () => {
    expect(serverFormProblem(commandForm({ env: [row('', '')] }))).toBeNull();
  });
});

describe('serverInputFrom', () => {
  it('sends a command server on, with its rows and who it skips', () => {
    expect(
      serverInputFrom(
        commandForm({
          args: '-y made-up@1.2.3',
          env: [
            row('MADE_UP_TOKEN', 'typed'),
            row('MADE_UP_SETTING', 'typed-2', true),
            row('', ''),
          ],
          excludedAgents: ['agent-a'],
        })
      )
    ).toEqual({
      name: 'made-up',
      enabled: true,
      excludedAgents: ['agent-a'],
      secretNames: ['MADE_UP_SETTING'],
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'made-up@1.2.3'],
        env: { MADE_UP_TOKEN: 'typed', MADE_UP_SETTING: 'typed-2' },
      },
    });
  });

  it('a URL means http, and the other kind’s rows stay behind', () => {
    const input = serverInputFrom(
      commandForm({
        kind: 'url',
        url: 'https://mcp.example.test/v1',
        env: [row('LEFT_BEHIND')],
        headers: [row('Authorization', 'typed')],
      })
    );
    expect(input.connection).toEqual({
      transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { Authorization: 'typed' },
    });
  });
});
