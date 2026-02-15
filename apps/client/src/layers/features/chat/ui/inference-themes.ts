import { DEFAULT_INFERENCE_VERBS } from './inference-verbs';

export interface IndicatorTheme {
  name: string;
  icon: string;                    // e.g. "*", "✦", "❄"
  iconAnimation: string | null;    // CSS @keyframes name, or null for static
  verbs: readonly string[];
  verbInterval: number;            // ms between rotations (default: 3500)
  completionVerb?: string;         // optional verb for complete state
}

export const DEFAULT_THEME: IndicatorTheme = {
  name: 'default',
  icon: '✨',
  iconAnimation: 'shimmer-pulse',
  verbs: DEFAULT_INFERENCE_VERBS,
  verbInterval: 3500,
};

// Example holiday theme (not active — demonstrates pluggable theme system):
//
// export const WINTER_THEME: IndicatorTheme = {
//   name: 'winter',
//   icon: '❄',
//   iconAnimation: null,  // static snowflake
//   verbs: ['Chillin\'', 'Frostin\'', 'Snowin\'', 'Freezin\'', 'Icin\''],
//   verbInterval: 4000,
//   completionVerb: 'Wrapped Up',
// };
