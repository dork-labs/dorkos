/**
 * Right-panel tab ids that a registration and a door into the tab both name.
 *
 * Kept here, in `shared`, so `init-extensions.ts` can register a tab without
 * importing the barrel of the widget that draws it: that import would pull the
 * whole widget into the startup bundle and defeat the tab's lazy load.
 *
 * @module shared/lib/right-panel-tab-ids
 */

/** The Work tab beside a DM (DOR-3075). */
export const WORK_PANEL_ID = 'work';
