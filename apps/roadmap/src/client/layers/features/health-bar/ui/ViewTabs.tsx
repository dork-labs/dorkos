import { useAppStore, type ViewMode } from '@/layers/shared/model';

const TABS: { id: ViewMode; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'kanban', label: 'Kanban' },
  { id: 'moscow', label: 'MoSCoW' },
  { id: 'gantt', label: 'Gantt' },
];

/**
 * Tab switcher for toggling between roadmap view modes.
 *
 * Reads from and writes to the global app store viewMode.
 */
export function ViewTabs() {
  const viewMode = useAppStore((s) => s.viewMode);
  const setViewMode = useAppStore((s) => s.setViewMode);

  return (
    <div
      className="flex gap-1 border-b border-neutral-200 bg-white px-6"
      role="tablist"
      aria-label="View mode"
    >
      {TABS.map((tab) => {
        const isActive = viewMode === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setViewMode(tab.id)}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 ${
              isActive
                ? 'border-neutral-900 text-neutral-900'
                : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-700'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
