// UI components — homepage (new narrative arc)
export { Prelude } from './ui/Prelude';
export { ActivityFeedHero } from './ui/ActivityFeedHero';
export { VillainSection } from './ui/VillainSection';
export { PivotSection } from './ui/PivotSection';
export { TimelineSection } from './ui/TimelineSection';
export { SubsystemsSection } from './ui/SubsystemsSection';
export { HonestySection } from './ui/HonestySection';
export { InstallMoment } from './ui/InstallMoment';
export { IdentityClose } from './ui/IdentityClose';
export { FAQSection } from './ui/FAQSection';

// UI components — chrome
export { MarketingNav } from './ui/MarketingNav';
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

// Data
export { systemModules } from './lib/modules';
export { villainCards } from './lib/villain-cards';
export { subsystems } from './lib/subsystems';
export { timelineEntries } from './lib/timeline-entries';
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

// Types
export type { NavLink } from './lib/types';
export type { SystemModule } from './lib/modules';
export type { VillainCard } from './lib/villain-cards';
export type { Subsystem, Integration } from './lib/subsystems';
export type { TimelineEntry } from './lib/timeline-entries';
export type { FaqItem } from './lib/faq-items';
