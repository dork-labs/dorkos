import { DorkHub } from '@/layers/features/marketplace';

/**
 * Dork Hub page widget — renders the marketplace browse experience at /marketplace.
 *
 * This is a thin shell: all layout (sidebar, header) is provided by `AppShell`
 * via its route-aware slot hooks. The page component only renders the feature content.
 */
export function DorkHubPage() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <DorkHub />
    </div>
  );
}
