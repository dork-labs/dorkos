/**
 * What a widget an app opens on the canvas may do when clicked (DOR-3293,
 * Security). A canvas widget's `agent`, `ui` and `emit` actions act for the
 * person: a click starts an agent turn in their name, runs a DorkOS command,
 * or saves a document event. An app's frame never gets that power by drawing
 * a button, so a widget an app opens may only link out (`url`). The window's
 * frame bridge refuses anything else when it reads the app's request, and the
 * server refuses it again when the canvas document is stored.
 *
 * @module shared/app-widget-actions
 */
import type { WidgetDocument } from './ui-widget.js';

/** The only action kind a widget an app opened may carry. */
export const APP_WIDGET_ACTION_KINDS: readonly string[] = ['url'];

/** The sentence an app reads when its widget is refused. */
export const APP_WIDGET_REFUSAL =
  'An app’s widget can only link to a web page. It can’t ask an agent, run a DorkOS command or send an event.';

/**
 * Every action kind a widget document carries, wherever it sits: a button's
 * `action`, a list item's `actions`, a board cell's `action`, and a form's or
 * checklist's submit `action`.
 *
 * @param value - A parsed widget document, or any part of one.
 */
export function widgetActionKinds(value: unknown): Set<string> {
  const kinds = new Set<string>();
  const visit = (node: unknown, key: string | undefined): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key === 'actions' ? 'action' : undefined);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const kind = (node as { kind?: unknown }).kind;
    if (key === 'action' && typeof kind === 'string') kinds.add(kind);
    for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
  };
  visit(value, undefined);
  return kinds;
}

/**
 * Whether a widget an app opened carries an action an app may not use.
 *
 * @param document - The widget document.
 */
export function appWidgetIsRefused(document: WidgetDocument): boolean {
  return [...widgetActionKinds(document)].some((kind) => !APP_WIDGET_ACTION_KINDS.includes(kind));
}
