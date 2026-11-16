/**
 * What a document marked as opened by an app may hold, checked where every
 * canvas write lands (DOR-3293, Security): a widget whose actions only link
 * out. An `agent`, `ui` or `emit` action acts for the person, so a document
 * still carrying an app's mark can never hold one, whichever route or tool
 * wrote it. The open route refuses it first with a plain answer; this is the
 * rule underneath, keyed on the mark rather than on who is writing.
 *
 * Every write after an app's own open also clears the mark today, so the
 * document is no longer the app's. This guard holds even if a later write
 * path forgets to.
 *
 * @module server/services/canvas/app-opened-content
 */
import { appWidgetIsRefused, APP_WIDGET_REFUSAL } from '@dorkos/shared/app-widget-actions';
import type { UiCanvasContent } from '@dorkos/shared/schemas';
import { RoomError } from '../rooms/room-errors.js';

/**
 * Throw unless content may sit in a document with this mark.
 *
 * @param openedByExtensionId - The document's "opened by" app, or none.
 * @param content - What the write would store.
 * @throws {RoomError} `CANVAS_APP_WIDGET_ACTION` for a widget an app may not open.
 */
export function assertAppOpenedContent(
  openedByExtensionId: string | null | undefined,
  content: UiCanvasContent | undefined
): void {
  if (!openedByExtensionId || content?.type !== 'widget') return;
  if (appWidgetIsRefused(content.definition)) {
    throw new RoomError('CANVAS_APP_WIDGET_ACTION', APP_WIDGET_REFUSAL);
  }
}
