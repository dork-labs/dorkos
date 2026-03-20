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
export { PulseAnimation } from './ui/PulseAnimation';

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

// UI components — legacy (kept for potential reuse on other pages)
export { Hero } from './ui/Hero';
export { CredibilityBar } from './ui/CredibilityBar';
export { ProblemSection } from './ui/ProblemSection';
export { HowItWorksSection } from './ui/HowItWorksSection';
export { ProjectCard } from './ui/ProjectCard';
export { ProjectsGrid } from './ui/ProjectsGrid';
export { NotSection } from './ui/NotSection';
export { PhilosophyCard } from './ui/PhilosophyCard';
export { PhilosophyGrid } from './ui/PhilosophyGrid';
export { AboutSection } from './ui/AboutSection';
export { ContactSection } from './ui/ContactSection';
export { SystemArchitecture } from './ui/SystemArchitecture';
export { UseCasesGrid } from './ui/UseCasesGrid';

// Feature catalog components
export { FeatureCard } from './ui/FeatureCard';
export { FeatureCatalogSection } from './ui/FeatureCatalogSection';

// Data — feature catalog
export { features, CATEGORY_LABELS } from './lib/features';
export type { Feature, FeatureStatus, FeatureCategory } from './lib/features';

// Data
export { projects } from './lib/projects';
export { philosophyItems } from './lib/philosophy';
export { systemModules } from './lib/modules';
export { useCases } from './lib/use-cases';
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
export type { Project, PhilosophyItem, NavLink } from './lib/types';
export type { SystemModule } from './lib/modules';
export type { UseCase } from './lib/use-cases';
export type { VillainCard } from './lib/villain-cards';
export type { Subsystem, Integration } from './lib/subsystems';
export type { TimelineEntry } from './lib/timeline-entries';
export type { FaqItem } from './lib/faq-items';
