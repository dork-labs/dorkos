/** Renders the runtime capabilities guide from its registry. */
import {
  MATRIX_GROUPS,
  MATRIX_RUNTIMES,
  type CellStatus,
  type MatrixCell,
  type MatrixEvidenceReference,
  type RuntimeCapability,
} from './runtime-capability-types.js';

/** What to call a status in the doc. */
const STATUS_MARK: Readonly<Record<CellStatus, string>> = {
  supported: 'yes',
  partial: 'partial',
  unverified: 'unverified',
  planned: 'planned',
  'not-supported': 'no',
  'n/a': 'n/a',
};

/** One cell as the matrix table shows it. */
function cellText(cell: MatrixCell): string {
  const proof = cell.evidence?.length ? ` (${cell.evidence.join(', ')})` : '';
  const ticket = cell.ticket ? ` ${cell.ticket}` : '';
  return `${STATUS_MARK[cell.status]}${proof}${ticket}`;
}

/** Escapes a table cell. */
function md(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Links to the exact test title or report case from the guide. */
function evidenceLink(reference: MatrixEvidenceReference): string {
  const label = reference.tier === 'L' ? reference.caseId : reference.title;
  return `${reference.tier} [${label.replace(/[\\[\]]/g, '\\$&')}](../../${reference.file})`;
}

/**
 * Renders `contributing/capabilities/runtimes.md` from the registry.
 *
 * Deterministic and dependency-free, so the census can compare the committed
 * file to it byte for byte.
 *
 * @param rows - Capability rows shown in the guide.
 * @returns The document's full text.
 */
export function renderRuntimeCapabilityRows(rows: readonly RuntimeCapability[]): string {
  const out: string[] = [];
  const header = `| ID | Capability | ${MATRIX_RUNTIMES.join(' | ')} |`;
  const rule = `| --- | --- | ${MATRIX_RUNTIMES.map(() => '---').join(' | ')} |`;

  out.push(
    '<!-- Generated from packages/test-utils/src/runtime-capability-matrix.ts by `pnpm docs:runtime-capabilities`. Do not edit by hand. -->',
    '',
    '# Runtime capabilities',
    '',
    'What every agent runtime DorkOS runs should do, and how far each one gets. This is the list of what runtimes **should** do, not only what is built: a capability nobody has built yet enters as a row marked `planned`, with the ticket that will build it.',
    '',
    'To add a capability, add a row to `packages/test-utils/src/runtime-capability-matrix.ts` and run `pnpm docs:runtime-capabilities`. The census (`apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts`) then checks it.',
    '',
    '**Statuses:** `yes` does what the row says. `partial` does some of it. `unverified` says it does and no test proves it yet. `planned` will, under the named ticket. `no` does not, and nothing is planned. `n/a` does not apply.',
    '',
    '**Proof tiers** are `U` for a deterministic CI test, `E` for a browser test on test-mode, and `L` for a live run against the real backend. Only `L` cells may be claimed in public copy.',
    '',
    'The census checks legacy `U` claims against runtime and conformance test titles. An explicit `U` or `E` reference names a test file and its exact test title. The census also checks the declared runtime flags, row IDs, and generated guide.',
    '',
    'An `L` reference names a passing case in a JSON receipt under `contributing/capabilities/runtime-evidence/`. Give the receipt a `runtime`, `runtimeVersion`, 40-character Git `revision`, `source` (`live-conformance`, `eval`, or `harness-smoke`), and `mode` set to `live`. Record each case’s `id` and `status` in `cases`. Review the scope of the run before citing it for a cell.',
    '',
    '`test-mode` is the scripted fixture runtime the browser tests use, not a product runtime.',
    ''
  );

  out.push('## Parity', '', `| Runtime | yes | partial | unverified | planned | no | n/a |`);
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const runtime of MATRIX_RUNTIMES) {
    const count = (status: CellStatus) =>
      rows.filter((row) => row.cells[runtime].status === status).length;
    out.push(
      `| ${runtime} | ${count('supported')} | ${count('partial')} | ${count('unverified')} | ${count('planned')} | ${count('not-supported')} | ${count('n/a')} |`
    );
  }
  out.push('');

  for (const [group, heading] of Object.entries(MATRIX_GROUPS)) {
    const inGroup = rows.filter((row) => row.group === group);
    if (inGroup.length === 0) continue;
    out.push(`## ${heading}`, '', header, rule);
    for (const row of inGroup) {
      out.push(
        `| ${row.id} | ${md(row.title)} | ${MATRIX_RUNTIMES.map((runtime) => md(cellText(row.cells[runtime]))).join(' | ')} |`
      );
    }
    out.push('');
    for (const row of inGroup) {
      const sources = [
        row.flag ? `flag \`${row.flag.label}\`` : null,
        row.conformance?.length ? `conformance ${row.conformance.join(', ')}` : null,
      ].filter(Boolean);
      out.push(
        `- **${row.id}** ${md(row.expected)}${sources.length ? ` _(${sources.join('; ')})_` : ''}`
      );
      for (const runtime of MATRIX_RUNTIMES) {
        const references = row.cells[runtime].references;
        if (references?.length) {
          out.push(`  - ${runtime}. ${references.map(evidenceLink).join(', ')}`);
        }
      }
    }
    out.push('');
  }

  out.push(
    '## Gaps',
    '',
    'Every cell that is not `yes`, `no` or `n/a`, planned work first.',
    '',
    '| ID | Runtime | Status | Ticket | Why |',
    '| --- | --- | --- | --- | --- |'
  );
  const order: readonly CellStatus[] = ['planned', 'partial', 'unverified'];
  for (const status of order) {
    for (const row of rows) {
      for (const runtime of MATRIX_RUNTIMES) {
        const cell = row.cells[runtime];
        if (cell.status !== status) continue;
        out.push(
          `| ${row.id} | ${runtime} | ${STATUS_MARK[status]} | ${cell.ticket ?? ''} | ${md(cell.reason ?? '')} |`
        );
      }
    }
  }
  out.push('');
  return out.join('\n');
}
