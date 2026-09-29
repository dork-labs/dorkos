import { Fragment } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import type { StatusBarSlotContext } from '@dorkos/extension-api';
import type { StatusBarContribution } from '@/layers/shared/model';

/** Props for {@link ExtensionStatusItems}. */
export interface ExtensionStatusItemsProps {
  /** The chat the status bar belongs to, handed to every item as its props. */
  ctx: StatusBarSlotContext;
  /** The items whose `when` said to show them, in order. */
  items: readonly StatusBarContribution[];
}

/**
 * Every visible extension item, drawn inside the status bar's one `extensions`
 * slot (spec `flow-multiproject` §6.6).
 *
 * Each item is its own labelled group inside its own error boundary: an
 * extension that throws while drawing disappears from the line and takes
 * nothing else with it. Items are separated the way the line separates its own.
 *
 * @param props - The chat's slot context and the items to draw.
 */
export function ExtensionStatusItems({ ctx, items }: ExtensionStatusItemsProps) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {items.map((item, index) => {
        const Item = item.component;
        return (
          <Fragment key={item.id}>
            {index > 0 && (
              <span className="text-muted-foreground/30 shrink-0" aria-hidden="true">
                &middot;
              </span>
            )}
            <span
              role="group"
              aria-label={item.label}
              data-testid={`extension-status-item-${item.id}`}
              className="inline-flex min-w-0 items-center"
            >
              <ErrorBoundary fallback={null} onError={(error) => reportItemError(item, error)}>
                <Item {...ctx} />
              </ErrorBoundary>
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

/** Say which extension's item broke, once per failure. */
function reportItemError(item: StatusBarContribution, error: unknown): void {
  console.warn(
    `[extensions] ${item.extensionId}'s status-bar item "${item.id}" failed to draw and is hidden.`,
    error
  );
}

/**
 * The same items as rows, for the Session panel behind the `⋯`: each item's
 * name, then the item itself. This is where an item is still reachable when the
 * bar's width budget had no room for the Add-ons slot and counted it in `+N`.
 *
 * @param props - The chat's slot context and the items to draw.
 */
export function ExtensionStatusRows({ ctx, items }: ExtensionStatusItemsProps) {
  return (
    <>
      {items.map((item) => {
        const Item = item.component;
        return (
          <div
            key={item.id}
            role="group"
            aria-label={item.label}
            data-testid={`session-row-extension-${item.id}`}
            className="flex items-center gap-2 px-1 py-1 text-sm"
          >
            <span className="shrink-0">{item.label}</span>
            <span className="min-w-0 flex-1" />
            <span className="text-muted-foreground inline-flex min-w-0 items-center text-xs">
              <ErrorBoundary fallback={null} onError={(error) => reportItemError(item, error)}>
                <Item {...ctx} />
              </ErrorBoundary>
            </span>
          </div>
        );
      })}
    </>
  );
}
