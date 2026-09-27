import type { ReactNode } from 'react';
import { Bot, Cable } from 'lucide-react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';

interface AppUseChoiceProps {
  /** The app with two uses left (Slack), or `null` when closed. */
  service: ConnectorCatalogService | null;
  /** Close without choosing. */
  onClose: () => void;
  /** Talk to agents through the app's own bot. */
  onChooseChat: (service: ConnectorCatalogService) => void;
  /** Let agents use the person's own account in the app. */
  onChooseAccount: (service: ConnectorCatalogService) => void;
}

/**
 * "What do you want to do?" for the few apps that do two things (design record
 * §9 rule 3): talk to your agents through a bot, or let agents use your own
 * account. One row per app, and only these apps ask. Pick one; the other can
 * be added later from the same row.
 */
export function AppUseChoice({
  service,
  onClose,
  onChooseChat,
  onChooseAccount,
}: AppUseChoiceProps) {
  const name = service?.displayName ?? '';
  return (
    <ResponsiveDialog open={service !== null} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="min-h-0 sm:max-w-md" data-testid="app-use-choice">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Connect {name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>What do you want to do?</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-2 pb-5">
          <UseOption
            icon={<Bot className="size-4" aria-hidden />}
            title={`Talk to my agents in ${name}`}
            detail={`Your agents get a ${name} bot. You message it, they answer.`}
            onClick={() => service && onChooseChat(service)}
          />
          <UseOption
            icon={<Cable className="size-4" aria-hidden />}
            title={`Let agents use my ${name}`}
            detail="Agents can read and post as you."
            onClick={() => service && onChooseAccount(service)}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function UseOption({
  icon,
  title,
  detail,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-muted/40 hover:bg-muted/70 focus-ring flex w-full items-start gap-3 rounded-xl p-3.5 text-left transition-colors"
    >
      <span className="bg-background text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{detail}</span>
      </span>
    </button>
  );
}
