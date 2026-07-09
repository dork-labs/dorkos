import { useId, useMemo, useState } from 'react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { Checkbox, Label } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { WidgetActionButton } from './ActionNodes';

type ChecklistNodeData = Extract<WidgetNode, { type: 'checklist' }>;

/**
 * `checklist` node — a list of toggleable items with local checked state seeded
 * from the widget. When an `action` is present, a submit button posts the
 * current checked/unchecked label sets back to the agent (merged into the action
 * payload, mirroring the `form` submit pattern).
 */
export function ChecklistNode({ node }: { node: ChecklistNodeData }) {
  const baseId = useId();
  const [checked, setChecked] = useState<boolean[]>(() =>
    node.items.map((item) => item.checked ?? false)
  );

  // Partition labels by current state and merge them into the agent action
  // payload, so the agent learns exactly what the user confirmed.
  const submitAction = useMemo(() => {
    if (!node.action) return null;
    const checkedLabels = node.items.filter((_, i) => checked[i]).map((item) => item.label);
    const uncheckedLabels = node.items.filter((_, i) => !checked[i]).map((item) => item.label);
    return {
      ...node.action,
      payload: {
        ...(node.action.payload ?? {}),
        checked: checkedLabels,
        unchecked: uncheckedLabels,
      },
    };
  }, [node.action, node.items, checked]);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {node.items.map((item, i) => {
          const id = `${baseId}-${i}`;
          return (
            <li key={i} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                checked={checked[i]}
                onCheckedChange={(value) =>
                  setChecked((prev) => prev.map((c, ci) => (ci === i ? value === true : c)))
                }
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <Label
                  htmlFor={id}
                  className={cn(
                    'text-sm font-normal transition-colors',
                    checked[i] && 'text-muted-foreground line-through'
                  )}
                >
                  {item.label}
                </Label>
                {item.note && <p className="text-muted-foreground text-xs">{item.note}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      {submitAction && (
        <WidgetActionButton action={submitAction} label={node.submitLabel ?? 'Confirm'} fullWidth />
      )}
    </div>
  );
}
