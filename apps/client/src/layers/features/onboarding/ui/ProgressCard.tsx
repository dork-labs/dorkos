import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import {
  ChevronRight,
  Compass,
  MessageSquare,
  Plug,
  Plus,
  Clock,
  Server,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { DORKBOT_ONBOARDING_LINES } from '@dorkos/shared/dorkbot-templates';
import {
  useAgentCreationStore,
  useAppStore,
  useOpenConnections,
  useSettingsDeepLink,
} from '@/layers/shared/model';
import { useDefaultAgentSession } from '@/layers/entities/config';
import { useProfile } from '../model/use-profile';
import { ProfileRolePicker } from './ProfileRolePicker';

interface ProgressCardProps {
  /** Called when the user dismisses the getting-started card permanently. */
  onDismiss: () => void;
}

interface GettingStartedItem {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

/** Where the inline role picker is in its closed → open → saving arc. */
type ProfileRowPhase = 'closed' | 'open' | 'saving' | 'error';

/**
 * Compact sidebar "Getting started" card. The first row starts a conversation
 * with the default agent (DorkBot on a fresh install); the rest are deep links
 * into the real surface for each task — creating an agent, scheduling a task,
 * connecting more runtimes, connecting a service — rather than a replay of
 * onboarding steps. Shown after the first-run flow finishes, until the user
 * dismisses it.
 *
 * While the profile is still empty, a "Tell DorkBot about your work" row sits
 * right after "Talk to DorkBot" and expands the shared role picker inline
 * (spec `user-profile-onboarding` §ProgressCard items). The "Connect a service"
 * row deep-links to the Accounts region of the Connections page
 * (`/connections?region=accounts`).
 */
export function ProgressCard({ onDismiss }: ProgressCardProps) {
  const reducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const { open: openSettings } = useSettingsDeepLink();
  const openConnections = useOpenConnections();
  const requestTour = useAppStore((s) => s.requestTour);
  const { startSession } = useDefaultAgentSession();
  const { roles, rolePromptDismissedAt, isLoading, saveRoles } = useProfile();

  const [profilePhase, setProfilePhase] = useState<ProfileRowPhase>('closed');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);

  // Only while nothing is saved and the one-time prompt was not waved off; the
  // row disappears on its own once roles exist. Gated on the config query so a
  // user who HAS roles never sees the row flash while it loads.
  const showProfileRow = !isLoading && roles.length === 0 && rolePromptDismissedAt === null;

  const handleProfileSave = () => {
    setProfilePhase('saving');
    saveRoles(selectedRoles)
      .then(() => setProfilePhase('closed'))
      .catch(() => setProfilePhase('error'));
  };

  let profileConfirmLabel = 'Save';
  if (profilePhase === 'saving') {
    profileConfirmLabel = 'Saving…';
  } else if (profilePhase === 'error') {
    profileConfirmLabel = 'Try again';
  }

  const items: GettingStartedItem[] = [
    {
      icon: MessageSquare,
      label: 'Talk to DorkBot',
      onClick: startSession,
    },
    ...(showProfileRow
      ? [
          {
            icon: UserRound,
            label: 'Tell DorkBot about your work',
            onClick: () => setProfilePhase((phase) => (phase === 'closed' ? 'open' : 'closed')),
          },
        ]
      : []),
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
      label: 'Connect more runtimes',
      onClick: () => openSettings('runtimes'),
    },
    {
      icon: Plug,
      label: 'Connect a service',
      onClick: () => openConnections('accounts'),
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
              aria-expanded={
                label === 'Tell DorkBot about your work' ? profilePhase !== 'closed' : undefined
              }
            >
              <Icon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="text-foreground flex-1 text-xs">{label}</span>
              <ChevronRight className="text-muted-foreground/40 group-hover:text-muted-foreground size-3.5 shrink-0 transition-colors" />
            </button>
            {label === 'Tell DorkBot about your work' && profilePhase !== 'closed' && (
              <div className="px-1.5 py-2" data-testid="progress-card-profile-picker">
                <ProfileRolePicker
                  selected={selectedRoles}
                  onChange={setSelectedRoles}
                  onConfirm={handleProfileSave}
                  confirmLabel={profileConfirmLabel}
                  busy={profilePhase === 'saving'}
                  error={profilePhase === 'error' ? DORKBOT_ONBOARDING_LINES.saveError : null}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}
