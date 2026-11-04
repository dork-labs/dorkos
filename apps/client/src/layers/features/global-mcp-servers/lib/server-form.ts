/**
 * The Add a server form as data: what a person typed, what is wrong with it, and the input it
 * sends. A secret's value lives here only until the form closes.
 *
 * @module features/global-mcp-servers/lib/server-form
 */
import {
  GLOBAL_MCP_URL_PATTERN,
  GlobalMcpServerInputSchema,
  GlobalMcpServerNameSchema,
  globalMcpArgsFit,
  isSecretName,
  type GlobalMcpServerInput,
} from '@dorkos/shared/global-mcp-schemas';
import { z } from 'zod';

/** One environment variable or header being typed. */
export interface FieldRow {
  id: string;
  name: string;
  value: string;
  /** The person pressed the lock. A name matching the secret rule is secret either way. */
  marked: boolean;
}

/** How the server is reached: a program to run, or an address. */
export type ServerKind = 'command' | 'url';

/** Everything the form holds. */
export interface ServerForm {
  name: string;
  kind: ServerKind;
  command: string;
  args: string;
  url: string;
  env: FieldRow[];
  headers: FieldRow[];
  excludedAgents: string[];
}

/** A form with nothing typed yet. */
export const EMPTY_SERVER_FORM: ServerForm = {
  name: '',
  kind: 'command',
  command: '',
  args: '',
  url: '',
  env: [],
  headers: [],
  excludedAgents: [],
};

/** The one thing to fix before the form can go, and the field it belongs to. */
export interface FormProblem {
  field: 'name' | 'command' | 'args' | 'url' | 'rows';
  message: string;
}

/**
 * Split an arguments line the way a shell would for plain words and quotes: `-y "a b"` is two
 * arguments. A quote with no end stays part of its word.
 *
 * @param text - What the person typed.
 */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S)/g;
  let current: string | null = null;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    // A gap since the last piece ends the argument.
    if (current !== null && match.index > end) {
      args.push(current);
      current = null;
    }
    current = (current ?? '') + (match[1] ?? match[2] ?? match[3] ?? '');
    end = match.index + match[0].length;
  }
  if (current !== null) args.push(current);
  return args;
}

/**
 * Whether a row's value is secret: its name matches the rule, or the person marked it.
 *
 * @param row - The row.
 */
export function rowIsSecret(row: FieldRow): boolean {
  return isSecretName(row.name.trim(), row.marked ? [row.name.trim()] : []);
}

/** The rows the form's kind sends: a row with nothing in it is not a row. */
function liveRows(form: ServerForm): FieldRow[] {
  const rows = form.kind === 'command' ? form.env : form.headers;
  return rows.filter((row) => row.name.trim() !== '' || row.value !== '');
}

/**
 * The first thing to fix, top to bottom, or `null` when the form can go.
 *
 * @param form - The form.
 */
export function serverFormProblem(form: ServerForm): FormProblem | null {
  if (!GlobalMcpServerNameSchema.safeParse(form.name.trim()).success) {
    return { field: 'name', message: 'Name it with letters, numbers, dashes and underscores.' };
  }
  if (form.kind === 'command' && form.command.trim() === '') {
    return { field: 'command', message: 'Type the program to run.' };
  }
  if (form.kind === 'command' && !globalMcpArgsFit(splitArgs(form.args))) {
    return { field: 'args', message: 'Those arguments are too long.' };
  }
  const url = form.url.trim();
  if (
    form.kind === 'url' &&
    !(GLOBAL_MCP_URL_PATTERN.test(url) && z.string().url().safeParse(url).success)
  ) {
    return { field: 'url', message: 'Type the full address, starting with https://' };
  }
  const seen = new Set<string>();
  for (const row of liveRows(form)) {
    const name = row.name.trim();
    if (name === '') return { field: 'rows', message: 'Name each value.' };
    if (seen.has(name)) return { field: 'rows', message: `${name} is there twice.` };
    seen.add(name);
    if (row.value === '' && rowIsSecret(row)) {
      return { field: 'rows', message: `Type a value for ${name}.` };
    }
  }
  return null;
}

/**
 * The input a finished form sends. On, because pressing Add is asking for it to run. The names a
 * person marked go as `secretNames`, and a marked name the rule already covers changes nothing.
 *
 * @param form - A form {@link serverFormProblem} passed.
 */
export function serverInputFrom(form: ServerForm): GlobalMcpServerInput {
  const rows = liveRows(form);
  const values = Object.fromEntries(rows.map((row) => [row.name.trim(), row.value]));
  return GlobalMcpServerInputSchema.parse({
    name: form.name.trim(),
    enabled: true,
    excludedAgents: form.excludedAgents,
    secretNames: rows.filter((row) => row.marked).map((row) => row.name.trim()),
    connection:
      form.kind === 'command'
        ? {
            transport: 'stdio',
            command: form.command.trim(),
            args: splitArgs(form.args),
            env: values,
          }
        : { transport: 'http', url: form.url.trim(), headers: values },
  });
}
