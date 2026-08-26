/**
 * The clips rail: a horizontally scrolling shelf of 9:16 tiles.
 *
 * One component and one config object, deliberately. Sibling pages re-theme
 * this exact section under their own names, so everything editorial — the
 * eyebrow, the heading, the lede, every tile, the end card — arrives through
 * {@link TutorialRailConfig}, and nothing about how it looks is spelled out in
 * a caller. `TUTORIALS` is the home page's instance of it.
 *
 * @module app/(marketing)/_components/tutorials
 */

export { TutorialsSection } from './TutorialsSection';
export { TUTORIALS } from './tutorials';
export type {
  TutorialRailConfig,
  TutorialCardSpec,
  TutorialClip,
  TutorialPlate,
} from './tutorials';
