// UI components — homepage (new narrative arc)
export { Prelude } from './ui/Prelude'
export { ActivityFeedHero } from './ui/ActivityFeedHero'
export { VillainSection } from './ui/VillainSection'
export { PivotSection } from './ui/PivotSection'
export { TimelineSection } from './ui/TimelineSection'
export { SubsystemsSection } from './ui/SubsystemsSection'
export { HonestySection } from './ui/HonestySection'
export { InstallMoment } from './ui/InstallMoment'
export { IdentityClose } from './ui/IdentityClose'
export { FAQSection } from './ui/FAQSection'

// UI components — chrome
export { MarketingNav } from './ui/MarketingNav'
export { MarketingHeader } from './ui/MarketingHeader'
export { MarketingFooter } from './ui/MarketingFooter'
export { PulseAnimation } from './ui/PulseAnimation'

// UI components — legacy (kept for potential reuse on other pages)
export { Hero } from './ui/Hero'
export { CredibilityBar } from './ui/CredibilityBar'
export { ProblemSection } from './ui/ProblemSection'
export { HowItWorksSection } from './ui/HowItWorksSection'
export { ProjectCard } from './ui/ProjectCard'
export { ProjectsGrid } from './ui/ProjectsGrid'
export { NotSection } from './ui/NotSection'
export { PhilosophyCard } from './ui/PhilosophyCard'
export { PhilosophyGrid } from './ui/PhilosophyGrid'
export { AboutSection } from './ui/AboutSection'
export { ContactSection } from './ui/ContactSection'
export { SystemArchitecture } from './ui/SystemArchitecture'
export { UseCasesGrid } from './ui/UseCasesGrid'

// Data
export { projects } from './lib/projects'
export { philosophyItems } from './lib/philosophy'
export { systemModules } from './lib/modules'
export { useCases } from './lib/use-cases'
export { villainCards } from './lib/villain-cards'
export { subsystems } from './lib/subsystems'
export { timelineEntries } from './lib/timeline-entries'
export { faqItems } from './lib/faq-items'

// Motion
export { SPRING, VIEWPORT, REVEAL, STAGGER, SCALE_IN, DRAW_PATH } from './lib/motion-variants'

// Types
export type { Project, PhilosophyItem, NavLink } from './lib/types'
export type { SystemModule } from './lib/modules'
export type { UseCase } from './lib/use-cases'
export type { VillainCard } from './lib/villain-cards'
export type { Subsystem, Integration } from './lib/subsystems'
export type { TimelineEntry } from './lib/timeline-entries'
export type { FaqItem } from './lib/faq-items'
