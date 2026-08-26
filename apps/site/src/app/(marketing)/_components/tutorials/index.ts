/**
 * The clips rail: a horizontally scrolling shelf of 9:16 tiles.
 *
 * One component and one config object, deliberately. Everything editorial —
 * the eyebrow, the heading, the lede, every tile, the end card — arrives
 * through the `TutorialRailConfig` in `./tutorials`, and nothing about how it
 * looks is spelled out in a caller. `TUTORIALS` is the home page's instance of
 * it, and the only thing a caller needs to name; a page that builds a config
 * of its own imports the type from `./tutorials` and adds it here.
 *
 * @module app/(marketing)/_components/tutorials
 */

export { TutorialsSection } from './TutorialsSection';
export { TUTORIALS } from './tutorials';
