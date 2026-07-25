// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ColumnDef } from '@tanstack/react-table';

import { DataTable } from '../data-table';

// ── Mock useIsMobile ──────────────────────────────────────────

const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useIsMobile: () => mockUseIsMobile() };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// ── Fixtures ──────────────────────────────────────────────────

interface Row {
  name: string;
  bucket: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'name', header: 'Name', cell: ({ row }) => row.original.name },
  { accessorKey: 'bucket', header: 'Bucket', cell: ({ row }) => row.original.bucket },
];

const rows: Row[] = [
  { name: 'a', bucket: 'first' },
  { name: 'b', bucket: 'first' },
  { name: 'c', bucket: 'second' },
];

const groupHeaders = () =>
  Array.from(document.querySelectorAll('[data-slot="data-table-group-header"]')).map(
    (el) => el.textContent
  );

// ── Tests ─────────────────────────────────────────────────────

describe('DataTable grouping', () => {
  afterEach(cleanup);

  it('renders no group headers without groupBy', () => {
    render(<DataTable columns={columns} data={rows} />);

    expect(groupHeaders()).toEqual([]);
    expect(screen.getByText('a')).toBeInTheDocument();
  });

  it('renders one header per group with its row count', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        groupBy={{ key: (row) => row.bucket, header: (key, count) => `${key} (${count})` }}
      />
    );

    expect(groupHeaders()).toEqual(['first (2)', 'second (1)']);
  });

  it('spans the header across every visible column', () => {
    render(
      <DataTable
        columns={columns}
        data={rows}
        groupBy={{ key: (row) => row.bucket, header: (key) => key }}
      />
    );

    const header = document.querySelector('[data-slot="data-table-group-header"] th');
    expect(header).toHaveAttribute('colspan', '2');
  });

  it('renders no group headers when there is no data', () => {
    render(
      <DataTable
        columns={columns}
        data={[]}
        emptyMessage="Nothing here."
        groupBy={{ key: (row) => row.bucket, header: (key) => key }}
      />
    );

    expect(groupHeaders()).toEqual([]);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });
});
