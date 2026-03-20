import { Palette, TextCursorInput, Component, MessageSquare, Blocks } from 'lucide-react';
import {
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CHAT_SECTIONS,
  FEATURES_SECTIONS,
} from '../playground-registry';
import type { Page, PlaygroundSection } from '../playground-registry';

interface OverviewPageProps {
  /** Called when the user clicks a category card to navigate to that page. */
  onNavigate: (page: Page) => void;
}

interface CategoryCard {
  page: Page;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  sections: PlaygroundSection[];
}

const CATEGORIES: CategoryCard[] = [
  {
    page: 'tokens',
    label: 'Design Tokens',
    description:
      'Color palette, typography, spacing, border radius, and shadow tokens that define the visual language.',
    icon: Palette,
    sections: TOKENS_SECTIONS,
  },
  {
    page: 'forms',
    label: 'Forms',
    description:
      'Form primitives and composed input components — inputs, selects, comboboxes, and tag inputs.',
    icon: TextCursorInput,
    sections: FORMS_SECTIONS,
  },
  {
    page: 'components',
    label: 'Components',
    description:
      'Interactive gallery of shared UI primitives — buttons, overlays, navigation, and feedback.',
    icon: Component,
    sections: COMPONENTS_SECTIONS,
  },
  {
    page: 'chat',
    label: 'Chat Components',
    description:
      'Visual testing gallery for chat UI — messages, tool calls, input, status indicators, and misc.',
    icon: MessageSquare,
    sections: CHAT_SECTIONS,
  },
  {
    page: 'features',
    label: 'Feature Components',
    description: 'Domain-specific components from Relay, Mesh, Pulse, and Onboarding features.',
    icon: Blocks,
    sections: FEATURES_SECTIONS,
  },
];

/** Overview landing page for the dev playground — entry point with category cards. */
export function OverviewPage({ onNavigate }: OverviewPageProps) {
  return (
    <>
      <header className="border-border border-b px-6 py-4">
        <h1 className="text-xl font-bold">DorkOS Dev Playground</h1>
        <p className="text-muted-foreground text-sm">
          Design system reference and component showcase.
        </p>
      </header>

      <main className="mx-auto max-w-4xl p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CATEGORIES.map((category) => (
            <CategoryCardButton key={category.page} category={category} onNavigate={onNavigate} />
          ))}
        </div>
      </main>
    </>
  );
}

interface CategoryCardButtonProps {
  category: CategoryCard;
  onNavigate: (page: Page) => void;
}

function CategoryCardButton({ category, onNavigate }: CategoryCardButtonProps) {
  const { page, label, description, icon: Icon, sections } = category;

  return (
    <button
      type="button"
      onClick={() => onNavigate(page)}
      className="bg-card border-border hover:bg-accent focus-visible:ring-ring group flex flex-col gap-4 rounded-xl border p-6 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary flex size-10 items-center justify-center rounded-lg transition-colors">
        <Icon className="size-5" />
      </div>

      <div className="space-y-1">
        <h2 className="text-foreground text-base font-semibold">{label}</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
      </div>

      <div className="mt-auto">
        <span className="text-muted-foreground font-mono text-xs">{`${sections.length} sections`}</span>
      </div>
    </button>
  );
}
