'use client';

import { CHAT_SCRIPT, DOCK } from '../../../_components';

/** The message each dock tile lands in, so icon and sentence can be judged together. */
function messageFor(id: string): string {
  return CHAT_SCRIPT.find((line) => line.dockApp === id)?.text ?? '—';
}

/**
 * The five apps in both of their states: sitting on the dock, and after they
 * have flown into a message. Every app used by the script appears here.
 */
export function AppGallery() {
  return (
    <div className="border-border-warm bg-cream-white rounded-xl border p-6">
      <ul className="list-none space-y-4">
        {DOCK.map((app) => (
          <li key={app.id} className="flex flex-wrap items-center gap-4">
            <span
              className="border-border-warm bg-cream-white grid size-12 shrink-0 place-items-center rounded-xl border"
              style={{ color: app.color }}
              title={`${app.label} on the dock`}
            >
              <app.Icon size={20} />
            </span>
            <span
              className="border-border-warm size-12 shrink-0 rounded-xl border border-dashed"
              title="the empty slot it leaves behind"
            />
            <span className="text-charcoal min-w-0 text-sm">
              <span
                className="mr-1.5 inline-grid size-5 place-items-center rounded-md align-text-bottom"
                style={{ backgroundColor: `${app.color}22`, color: app.color }}
              >
                <app.Icon size={12} />
              </span>
              {messageFor(app.id)}
            </span>
            <span className="text-warm-gray ml-auto font-mono text-xs">
              {app.label} · {app.color}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
