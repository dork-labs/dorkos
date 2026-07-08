import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { resolveWidgetIcon } from '../../lib/widget-icon';
import { toneBadgeClass } from '../../lib/widget-tone';
import { WidgetActionButton } from './ActionNodes';

type ListNodeData = Extract<WidgetNode, { type: 'list' }>;

/** `list` node — a vertical list of items with optional icon, badge, and actions. */
export function ListNode({ node }: { node: ListNodeData }) {
  return (
    <ul className="divide-border divide-y">
      {node.items.map((item, i) => {
        const Icon = resolveWidgetIcon(item.icon);
        return (
          <li key={i} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
            {item.icon && <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />}
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-medium">{item.title}</p>
              {item.subtitle && (
                <p className="text-muted-foreground truncate text-xs">{item.subtitle}</p>
              )}
            </div>
            {item.badge && (
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                  toneBadgeClass(item.badge.tone)
                )}
              >
                {item.badge.text}
              </span>
            )}
            {item.actions && item.actions.length > 0 && (
              <div className="flex shrink-0 items-center gap-1.5">
                {item.actions.map((action, ai) => (
                  <WidgetActionButton
                    key={ai}
                    action={action}
                    label={action.kind === 'agent' ? (action.label ?? 'Action') : label(action)}
                  />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Derive a concise button label for a non-agent list action. */
function label(action: { kind: 'ui' | 'url' }): string {
  return action.kind === 'url' ? 'Open' : 'Run';
}
