/**
 * How mermaid diagrams look in canvas docs: the app's tokens, not mermaid's.
 *
 * Blintz draws each diagram with mermaid's own light or dark theme and drops
 * any `themeVariables` the host sets, so the house look comes in through
 * `themeCSS` instead. Every value is a CSS variable, so one stylesheet follows
 * the app between light and dark with nothing recomputed.
 *
 * `!important` is deliberate: mermaid 12's themes style nodes through
 * `[data-look="neo"]` selectors that outrank anything appended after them,
 * and this stylesheet only ever reaches the one diagram mermaid scopes it to.
 * Fonts are left to the `fontFamily` setting, because mermaid sizes each label
 * box by measuring text in that font; restyling the text would clip it. For the
 * same reason label paragraphs are pinned back to mermaid's size: the editor's
 * own paragraph style would otherwise reach into the diagram and enlarge them.
 *
 * @module features/canvas/ui/mermaid-settings
 */

/** A node's fill: the card colour with a faint tint, never pure white. */
const FILL = 'color-mix(in srgb, hsl(var(--foreground)) 4%, hsl(var(--card)))';

/** Tint over borders: soft fills, a faint edge, muted lines, no shadows. */
const DIAGRAM_CSS = `
  .node rect, .node circle, .node ellipse, .node polygon, .node path, .node .outer-path,
  .actor, .labelBox, .note, rect.task, .statediagram-state rect, .classGroup rect,
  .er.entityBox {
    fill: ${FILL} !important;
    stroke: hsl(var(--border)) !important;
    stroke-width: 1px !important;
    filter: none !important;
  }
  .cluster rect, .cluster path {
    fill: hsl(var(--muted)) !important;
    stroke: hsl(var(--border)) !important;
    filter: none !important;
  }
  .label, .nodeLabel, .edgeLabel, .cluster-label, text, tspan, .nodeLabel p, .edgeLabel p {
    color: hsl(var(--foreground)) !important;
    fill: hsl(var(--foreground)) !important;
  }
  .edgeLabel, .edgeLabel rect, .edgeLabel p, .labelBkg {
    background-color: ${FILL} !important;
    fill: ${FILL} !important;
  }
  .flowchart-link, .edgePath .path, .messageLine0, .messageLine1, .relation, .transition,
  .actor-line, .neo-line path {
    stroke: hsl(var(--muted-foreground)) !important;
  }
  .nodeLabel p, .edgeLabel p, foreignObject p {
    margin: 0 !important;
    padding: 0 !important;
    font-size: inherit !important;
    line-height: 1.5 !important;
  }
  .marker, marker path, .arrowheadPath, .arrowMarkerPath {
    fill: hsl(var(--muted-foreground)) !important;
    stroke: hsl(var(--muted-foreground)) !important;
  }
`;

/**
 * Settings applied once when mermaid loads. Blintz keeps them for every
 * diagram (minus `themeVariables`) and forces `securityLevel: "strict"`.
 */
export const MERMAID_SETTINGS = {
  /** The plain look; the newer one adds hard offset shadows to nodes. */
  look: 'classic',
  fontFamily: 'var(--font-sans)',
  themeCSS: DIAGRAM_CSS,
} as const;
