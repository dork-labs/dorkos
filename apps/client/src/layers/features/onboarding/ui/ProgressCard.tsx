import { motion, useReducedMotion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Compass,
  MessageSquare,
  Plus,
  Clock,
  Server,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAgentCreationStore, useAppStore } from '@/layers/shared/model';
import { useDefaultAgentSession } from '@/layers/entities/config';

interface ProgressCardProps {
  /** Called when the user dismisses the getting-started card permanently. */
  onDismiss: () => void;
}

interface GettingStartedItem {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

/**
 * Compact sidebar "Getting started" card. The first row starts a conversation
 * with the default agent (DorkBot on a fresh install); the rest are deep links
 * into the real surface for each task — creating an agent, scheduling a task,
 * connecting more runtimes — rather than a replay of onboarding steps. Shown
 * after the first-run flow finishes, until the user dismisses it.
 */
export function ProgressCard({ onDismiss }: ProgressCardProps) {
  const reducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const openSettingsToTab = useAppStore((s) => s.openSettingsToTab);
  const requestTour = useAppStore((s) => s.requestTour);
  const { startSession } = useDefaultAgentSession();

  const items: GettingStartedItem[] = [
    {
      icon: MessageSquare,
      label: 'Talk to DorkBot',
      onClick: startSession,
    },
    {
      icon: Compass,
      label: 'Show me around',
      onClick: () => requestTour('general'),
    },
    {
      icon: Plus,
      label: 'Create an agent',
      onClick: () => useAgentCreationStore.getState().open('new'),
    },
    {
      icon: Clock,
      label: 'Schedule a task',
      onClick: () => navigate({ to: '/tasks' }),
    },
    {
      icon: Server,
      label: 'Add more agents',
      onClick: () => openSettingsToTab('runtimes'),
    },
  ];

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="border-border bg-card relative rounded-lg border p-3"
    >
      <button
        onClick={onDismiss}
        className="text-muted-foreground/50 hover:text-muted-foreground absolute top-1.5 right-1.5 rounded-md p-0.5 transition-colors duration-150"
        aria-label="Dismiss getting started"
      >
        <X className="size-3.5" />
      </button>

      <h3 className="mb-2 text-xs font-medium">Getting started</h3>

      <ul className="space-y-0.5">
        {items.map(({ icon: Icon, label, onClick }) => (
          <li key={label}>
            <button
              onClick={onClick}
              className="hover:bg-accent group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-150"
            >
              <Icon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground flex-1 text-xs">{label}</span>
              <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-3.5 shrink-0 transition-colors" />
            </button>
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
