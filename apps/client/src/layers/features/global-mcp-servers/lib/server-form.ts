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
  splitArgs,
  isReservedMcpServerName,
  isSecretName,
  reservedMcpServerNameMessage,
  type GlobalMcpServerInput,
  type GlobalMcpServerView,
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
 * The problem when the Name is one of DorkOS's own, whatever its case, or `null`. Shown on
 * leaving the field, before anything else is typed (DOR-3600); the server refuses it too.
 *
 * @param name - The name as typed.
 */
export function reservedNameProblem(name: string): FormProblem | null {
  const trimmed = name.trim();
  return isReservedMcpServerName(trimmed)
    ? { field: 'name', message: reservedMcpServerNameMessage(trimmed) }
    : null;
}

/**
 * What is wrong with the Name alone, or `null`.
 *
 * @param name - The name as typed.
 */
export function nameProblem(name: string): FormProblem | null {
  if (!GlobalMcpServerNameSchema.safeParse(name.trim()).success) {
    return { field: 'name', message: 'Name it with letters, numbers, dashes and underscores.' };
  }
  return reservedNameProblem(name);
}

/** One argument as a person would type it, quoted when splitting would change it. */
function typedArg(arg: string): string {
  if (arg !== '' && !/[\s"']/.test(arg)) return arg;
  return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
}

/**
 * A form holding a saved server's command or address, arguments, values' names and which agents
 * it skips, with no name: "Remove and add again…" (DOR-4262). A saved value is never shown again,
 * so each row comes back empty, and an argument still hidden is refused until it is typed.
 *
 * @param server - The server, as the list reads it.
 */
export function formFromServer(server: GlobalMcpServerView): ServerForm {
  const rows = (fields: GlobalMcpServerView['env']): FieldRow[] =>
    fields.map((field, index) => ({
      id: `kept-${index}`,
      name: field.name,
      value: '',
      marked: field.secret,
    }));
  return {
    ...EMPTY_SERVER_FORM,
    kind: server.transport === 'stdio' ? 'command' : 'url',
    command: server.command ?? '',
    args: (server.args ?? []).map(typedArg).join(' '),
    url: server.url ?? '',
    env: rows(server.env),
    headers: rows(server.headers),
    excludedAgents: server.excludedAgents,
  };
}

/** How strict {@link serverFormProblem} is. */
export interface FormRules {
  /** Every row needs a value, not only a secret one: a re-added server's rows come back empty. */
  everyValue?: boolean;
}

/**
 * The first thing to fix, top to bottom, or `null` when the form can go.
 *
 * @param form - The form.
 * @param rules - What else must hold.
 */
export function serverFormProblem(form: ServerForm, rules: FormRules = {}): FormProblem | null {
  const named = nameProblem(form.name);
  if (named) return named;
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
    if (row.value === '' && (rules.everyValue || rowIsSecret(row))) {
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
