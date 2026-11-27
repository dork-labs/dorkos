/**
 * The global stream's event list in `docs/integrations/sse-protocol.mdx`,
 * written from the one event union's table
 * (`packages/shared/src/dorkos-event-types.ts`, DOR-4986), so the page cannot
 * drift from what the server sends.
 *
 * The list sits between two markers in the page; everything outside them is
 * hand-written and left alone. Run it after changing the table:
 * `pnpm docs:sse-events` (`pnpm docs:export-api` runs it too).
 * `scripts/__tests__/sse-event-table.test.ts` fails while the committed page and
 * the table disagree.
 *
 * The page is formatted with the repo's Prettier settings after the list is
 * written, so the output is what the commit hook would leave.
 *
 * @module scripts/lib/sse-event-table
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  DORKOS_EVENT_TYPES,
  EXTENSION_EVENT_INFO,
  type DorkOsEventTypeInfo,
} from '../../packages/shared/src/dorkos-event-types.ts';

/** The page, relative to the repo root. */
export const SSE_PROTOCOL_PAGE = 'docs/integrations/sse-protocol.mdx';

/** The line before the generated list. */
export const BEGIN_MARKER =
  '{/* BEGIN generated: the global event types, from packages/shared/src/dorkos-event-types.ts. Edit the table there, then run pnpm docs:sse-events. */}';

/** The line after the generated list. */
export const END_MARKER = '{/* END generated: the global event types */}';

/** One table cell, refused when it would break the Markdown table. */
function cell(text: string, where: string): string {
  if (/[|\r\n]/.test(text)) {
    throw new Error(`${where} holds a "|" or a line break, which would break the table.`);
  }
  return text;
}

/** One row: the type, its area, its payload in words, and its meaning. */
function row(name: string, info: DorkOsEventTypeInfo): string {
  const area = info.area === null ? 'none' : `\`${info.area}\``;
  const payload = info.payload === undefined ? 'not described yet' : `\`${info.payload}\``;
  return `| \`${name}\` | ${area} | ${cell(payload, `${name}'s payload`)} | ${cell(info.meaning, `${name}'s meaning`)} |`;
}

/** The generated list, without its markers, before formatting. */
export function renderEventTable(): string {
  const rows = Object.entries(DORKOS_EVENT_TYPES).map(([name, info]) => row(name, info));
  rows.push(row('ext:<extensionId>:<event>', { ...EXTENSION_EVENT_INFO, payload: 'varies' }));
  return ['| Event | Area | Payload | Meaning |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/**
 * The page with its generated list replaced by the current one, formatted.
 *
 * @param page - The page as it stands.
 * @param pagePath - The page's path, for Prettier's settings and the error.
 * @throws If the page does not hold the two markers once each, in order.
 */
export async function withEventTable(page: string, pagePath: string): Promise<string> {
  const begin = page.indexOf(BEGIN_MARKER);
  const end = page.indexOf(END_MARKER);
  if (
    begin === -1 ||
    end < begin ||
    page.indexOf(BEGIN_MARKER, begin + 1) !== -1 ||
    page.indexOf(END_MARKER, end + 1) !== -1
  ) {
    throw new Error(`${pagePath} must hold the generated-list markers once each, in order.`);
  }
  const spliced =
    page.slice(0, begin + BEGIN_MARKER.length) + `\n\n${renderEventTable()}\n\n` + page.slice(end);
  const config = (await resolveConfig(pagePath)) ?? {};
  return format(spliced, { ...config, filepath: pagePath });
}

/** Rewrite the committed page. */
async function main(): Promise<void> {
  const target = join(resolve(import.meta.dirname, '../..'), SSE_PROTOCOL_PAGE);
  writeFileSync(target, await withEventTable(readFileSync(target, 'utf8'), target));
  console.log(`Wrote the event list in ${target}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
