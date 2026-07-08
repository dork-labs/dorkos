import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { resolveWidgetIcon } from '../../lib/widget-icon';
import { toneBadgeClass } from '../../lib/widget-tone';
import { useWidgetMotion, widgetEntrance, widgetStaggerContainer } from '../../lib/widget-motion';
import { WidgetActionButton } from './ActionNodes';

type ListNodeData = Extract<WidgetNode, { type: 'list' }>;

/** `list` node — items cascade in and lift on hover; optional icon, badge, and actions. */
export function ListNode({ node }: { node: ListNodeData }) {
  const motionOn = useWidgetMotion();
  return (
    <motion.ul
      className="divide-border divide-y"
      variants={motionOn ? widgetStaggerContainer : undefined}
      initial={motionOn ? 'hidden' : false}
      animate={motionOn ? 'visible' : false}
    >
      {node.items.map((item, i) => {
        const Icon = resolveWidgetIcon(item.icon);
        return (
          <motion.li
            key={i}
            className="hover:bg-muted/40 -mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors"
            variants={motionOn ? widgetEntrance : undefined}
          >
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
          </motion.li>
        );
      })}
    </motion.ul>
  );
}

/** Derive a concise button label for a non-agent list action. */
function label(action: { kind: 'ui' | 'url' }): string {
  return action.kind === 'url' ? 'Open' : 'Run';
}
