import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import Papa from 'papaparse';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { resolveCanvasFetchUrl } from '../lib/fetch-src';

interface CanvasCsvContentProps {
  /** CSV canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'csv' }>;
}

/** Estimated row height for the virtualizer (px). */
const ROW_HEIGHT = 32;

/**
 * CSV canvas renderer: fetches the source (cwd-confined for local paths),
 * parses it with papaparse, and renders a virtualized table so large files stay
 * responsive. The first row is treated as a header.
 */
export function CanvasCsvContent({ content }: CanvasCsvContentProps) {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);

  const resolved = useMemo(
    () => resolveCanvasFetchUrl(content.src, (p) => transport.mediaUrl(cwd ?? '', p)),
    [content.src, transport, cwd]
  );

  const { data, error, isLoading } = useQuery({
    queryKey: ['canvas-csv', resolved.url],
    enabled: resolved.url !== null,
    queryFn: async () => {
      const res = await fetch(resolved.url as string);
      if (!res.ok) throw new Error(`Failed to load CSV (${res.status})`);
      const text = await res.text();
      const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
      return parsed.data;
    },
    staleTime: 60_000,
    retry: false,
  });

  if (resolved.url === null) {
    return <CsvMessage>This CSV source can&rsquo;t be displayed here.</CsvMessage>;
  }
  if (isLoading) {
    return <CsvMessage>Loading CSV…</CsvMessage>;
  }
  if (error || !data || data.length === 0) {
    return <CsvMessage>This CSV couldn&rsquo;t be loaded.</CsvMessage>;
  }

  const [header, ...rows] = data;
  return <CsvTable header={header} rows={rows} />;
}

/** Virtualized CSV table body. */
function CsvTable({ header, rows }: { header: string[]; rows: string[][] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-muted sticky top-0 z-10">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="text-muted-foreground border-b px-3 py-1.5 text-left font-medium whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <tr
                key={virtualRow.key}
                className={cn('absolute flex w-full', virtualRow.index % 2 === 1 && 'bg-muted/30')}
                style={{ transform: `translateY(${virtualRow.start}px)`, height: ROW_HEIGHT }}
              >
                {header.map((_, colIndex) => (
                  <td
                    key={colIndex}
                    className="flex-1 truncate border-b px-3 py-1.5 whitespace-nowrap"
                    title={row[colIndex] ?? ''}
                  >
                    {row[colIndex] ?? ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Centered muted message for empty/error/loading CSV states. */
function CsvMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}
