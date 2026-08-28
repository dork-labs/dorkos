// UI components — sections shared by the home page and the pages below it
export { InstallMoment } from './ui/InstallMoment';
export { FAQSection } from './ui/FAQSection';

// Data — the one list of site destinations, shared by every marketing surface
export { NAV_LINKS, isNavLinkActive } from './lib/nav-links';
export { FOOTER_SOCIAL_LINKS } from './lib/footer-social-links';

// UI components — chrome. `MarketingNav` is deliberately absent: the pill is
// only ever rendered by `MarketingChrome`, which is its neighbour, and the home
// page renders its own fork. Nothing outside this slice asks for it.
export { MarketingHeader } from './ui/MarketingHeader';
export { MarketingFooter } from './ui/MarketingFooter';
export { MarketingChrome } from './ui/MarketingChrome';

// UI components — story page
export { PresentationShell } from './ui/PresentationShell';
export { StoryHero } from './ui/story/StoryHero';
export { FounderSection } from './ui/story/FounderSection';
export { MondayMorningSection } from './ui/story/MondayMorningSection';
export { HowItBuiltSection } from './ui/story/HowItBuiltSection';
export { JustPromptsSection } from './ui/story/JustPromptsSection';
export { DemoSection } from './ui/story/DemoSection';
export { CloseSection } from './ui/story/CloseSection';
export { FutureVisionSection } from './ui/story/FutureVisionSection';

// Feature catalog components
export { FeatureCard } from './ui/FeatureCard';
export { FeatureCatalog } from './ui/FeatureCatalog';
export { FeatureCatalogSection } from './ui/FeatureCatalogSection';
export { ProductFrame } from './ui/ProductFrame';
export { ProductShot } from './ui/ProductShot';
export { ProductBadge } from './ui/ProductBadge';

// Data — feature catalog
export {
  features,
  PRODUCT_LABELS,
  PRODUCT_ACCENT,
  CATEGORY_LABELS,
  LOOP_SURFACES,
  FLAGSHIP_SLUG,
  BENTO_SPAN_CLASS,
  deriveFeatureSpan,
} from './lib/features';
export type {
  Feature,
  FeatureStatus,
  FeatureProduct,
  FeatureCategory,
  FeatureMedia,
  FeatureSpanKind,
  ProductAccent,
  ProductSurface,
  ProductCrop,
  ProductFrameVariant,
} from './lib/features';

// Comparison components
export { ComparisonVerdict } from './ui/compare/ComparisonVerdict';
export { ComparisonAudience } from './ui/compare/ComparisonAudience';
export { ComparisonTable } from './ui/compare/ComparisonTable';
export { ComparisonCriteria } from './ui/compare/ComparisonCriteria';
export { ComparisonFaq } from './ui/compare/ComparisonFaq';
export { ComparisonSources } from './ui/compare/ComparisonSources';
export { CompetitorCard } from './ui/compare/CompetitorCard';

// Data — comparison catalog. Only what the routes outside this slice consume:
// the dimension list, the scoring helpers and the cell types stay internal,
// where the comparison components import them by relative path.
export { comparisons, COMPARISON_FRAMING_COPY } from './lib/comparisons';
export type { Competitor, ComparisonFraming } from './lib/comparisons';

// Data — product-media shot registry (published in manifest.json)
export { PRODUCT_SHOTS, PRODUCT_SHOT_IDS, getProductShot, shotHasLoop } from './lib/shots';
export type { ProductShotMeta, ShotConsumer, ShotKind, ShotFrame } from './lib/shots';

// Data
export { systemModules } from './lib/modules';
export { subsystems } from './lib/subsystems';
export { faqItems } from './lib/faq-items';

// Data — story page
export { bootCards, evolutionSteps, equationItems, futureCards } from './lib/story-data';
export type { BootCard, EvolutionStep, EquationItem, FutureCard } from './lib/story-data';

// Motion
export {
  SPRING,
  VIEWPORT,
  VIEWPORT_REPEAT,
  REVEAL,
  STAGGER,
  SCALE_IN,
  DRAW_PATH,
} from './lib/motion-variants';

// Hooks
export { usePresentationMode } from './lib/use-presentation-mode';
export { usePresentationContext } from './lib/presentation-context';
export { usePlatform, detectPlatform } from './lib/use-platform';
export type { Platform } from './lib/use-platform';

// Types
export type { NavLink } from './lib/types';
export type { SystemModule } from './lib/modules';
export type { Subsystem } from './lib/subsystems';
export type { FaqItem } from './lib/faq-items';
