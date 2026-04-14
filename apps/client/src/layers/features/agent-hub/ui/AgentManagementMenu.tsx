import { useState } from 'react';
import type { ComponentType } from 'react';
import { MoreVertical, ShieldBan, ShieldCheck, Unplug, Trash2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  Button,
  Input,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  useUnregisterAgent,
  useRegisterAgent,
  useDenyAgent,
  useClearDenial,
  useDeniedAgents,
  useDeleteAgentData,
} from '@/layers/entities/mesh';
import { useAgentHubContext } from '../model/agent-hub-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 'actions' | 'confirm-block' | 'confirm-unregister' | 'confirm-delete';

interface AgentManagementMenuProps {
  className?: string;
}

// ---------------------------------------------------------------------------
// Action card sub-component
// ---------------------------------------------------------------------------

interface ActionCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  variant?: 'default' | 'destructive';
  onClick: () => void;
}

function ActionCard({
  icon: Icon,
  title,
  description,
  variant = 'default',
  onClick,
}: ActionCardProps) {
  const isDestructive = variant === 'destructive';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors',
        isDestructive ? 'hover:bg-destructive/10' : 'hover:bg-accent'
      )}
    >
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full',
          isDestructive ? 'bg-destructive/10' : 'bg-muted'
        )}
      >
        <Icon
          className={cn('size-4', isDestructive ? 'text-destructive' : 'text-muted-foreground')}
        />
      </div>
      <div className="min-w-0 pt-0.5">
        <div className={cn('text-sm font-medium', isDestructive && 'text-destructive')}>
          {title}
        </div>
        <div className="text-muted-foreground text-xs leading-relaxed">{description}</div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Confirmation header with back arrow
// ---------------------------------------------------------------------------

function ConfirmHeader({
  title,
  description,
  onBack,
}: {
  title: string;
  description: string;
  onBack: () => void;
}) {
  return (
    <ResponsiveDialogHeader>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground -ml-1 rounded-md p-1 transition-colors"
          aria-label="Back to actions"
        >
          <ArrowLeft className="size-4" />
        </button>
        <ResponsiveDialogTitle>{title}</ResponsiveDialogTitle>
      </div>
      <ResponsiveDialogDescription>{description}</ResponsiveDialogDescription>
    </ResponsiveDialogHeader>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Kebab-triggered management panel for the current agent.
 *
 * Opens a responsive dialog (dialog on desktop, drawer on mobile) with
 * three action cards — block/unblock, unregister, and delete — each with
 * an explanation and a confirmation step before execution.
 *
 * Destructive items are hidden for system agents.
 */
export function AgentManagementMenu({ className }: AgentManagementMenuProps) {
  const { agent, projectPath } = useAgentHubContext();
  const unregisterAgent = useUnregisterAgent();
  const registerAgent = useRegisterAgent();
  const denyAgent = useDenyAgent();
  const clearDenial = useClearDenial();
  const deleteAgentData = useDeleteAgentData();
  const { data: deniedData } = useDeniedAgents();

  const isSystem = agent.isSystem === true;
  const isDenied = deniedData?.denied?.some((d) => d.path === projectPath) ?? false;
  const displayName = agent.displayName ?? agent.name;

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('actions');
  const [deleteInput, setDeleteInput] = useState('');

  function handleOpenChange(value: boolean) {
    setOpen(value);
    if (!value) {
      setStep('actions');
      setDeleteInput('');
    }
  }

  function close() {
    setOpen(false);
  }

  // --- Mutation handlers ---

  function handleBlock() {
    if (isDenied) {
      clearDenial.mutate(projectPath, {
        onSuccess: () => {
          toast.success('Agent unblocked');
          close();
        },
      });
    } else {
      denyAgent.mutate(
        { path: projectPath, reason: 'Blocked via Agent Hub' },
        {
          onSuccess: () => {
            toast.success('Agent blocked');
            close();
          },
        }
      );
    }
  }

  function handleUnregister() {
    unregisterAgent.mutate(agent.id, {
      onSuccess: () => {
        toast(`Agent ${displayName} unregistered`, {
          action: {
            label: 'Undo',
            onClick: () => registerAgent.mutate({ path: projectPath }),
          },
          duration: 5000,
        });
        close();
      },
    });
  }

  function handleDelete() {
    deleteAgentData.mutate(agent.id, {
      onSuccess: () => {
        toast.error(`Deleted ${displayName} and all data`);
        close();
      },
    });
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('size-7 p-0', className)}
          aria-label="Agent management actions"
        >
          <MoreVertical className="size-4" />
        </Button>
      </ResponsiveDialogTrigger>

      <ResponsiveDialogContent className="min-h-0 sm:max-w-md">
        {/* ---- Step 1: Action cards ---- */}
        {step === 'actions' && (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>Manage {displayName}</ResponsiveDialogTitle>
              <ResponsiveDialogDescription className={isSystem ? undefined : 'sr-only'}>
                {isSystem
                  ? 'System agents are managed automatically.'
                  : 'Choose a management action for this agent.'}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody className="pb-6">
              {isSystem ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  System agents cannot be blocked, unregistered, or deleted.
                </p>
              ) : (
                <div className="space-y-1">
                  <ActionCard
                    icon={isDenied ? ShieldCheck : ShieldBan}
                    title={isDenied ? 'Unblock' : 'Block'}
                    description={
                      isDenied
                        ? 'Allow this agent to be discovered again in future scans.'
                        : 'Hide this agent from future scans. If you remove it later, it won\u2019t be automatically rediscovered.'
                    }
                    onClick={() => setStep('confirm-block')}
                  />
                  <ActionCard
                    icon={Unplug}
                    title="Unregister"
                    description="Remove this agent from your list. Your project files stay untouched and you can bring it back by re-scanning."
                    onClick={() => setStep('confirm-unregister')}
                  />
                  <div className="mx-3 border-t" />
                  <ActionCard
                    icon={Trash2}
                    title="Delete Agent & Data"
                    description="Permanently erase this agent's personality, settings, and custom rules. Your project files are not affected."
                    variant="destructive"
                    onClick={() => setStep('confirm-delete')}
                  />
                </div>
              )}
            </ResponsiveDialogBody>
          </>
        )}

        {/* ---- Confirm: Block / Unblock ---- */}
        {step === 'confirm-block' && (
          <>
            <ConfirmHeader
              title={`${isDenied ? 'Unblock' : 'Block'} ${displayName}?`}
              description={
                isDenied
                  ? 'This agent\u2019s location will be eligible for discovery again in future scans.'
                  : 'This agent\u2019s location will be hidden from future scans. If you unregister it later, it won\u2019t be automatically rediscovered. You can unblock it at any time.'
              }
              onBack={() => setStep('actions')}
            />
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button variant={isDenied ? 'default' : 'destructive'} onClick={handleBlock}>
                {isDenied ? 'Unblock' : 'Block'}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}

        {/* ---- Confirm: Unregister ---- */}
        {step === 'confirm-unregister' && (
          <>
            <ConfirmHeader
              title={`Unregister ${displayName}?`}
              description="This agent will disappear from your list and any scheduled tasks will be paused. Your project files stay exactly as they are."
              onBack={() => setStep('actions')}
            />
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button onClick={handleUnregister}>Unregister</Button>
            </ResponsiveDialogFooter>
          </>
        )}

        {/* ---- Confirm: Delete (type-to-confirm) ---- */}
        {step === 'confirm-delete' && (
          <>
            <ConfirmHeader
              title={`Delete ${displayName}?`}
              description={`This will permanently erase this agent's personality, custom rules, and all settings. Your project files at ${projectPath} are not affected. This cannot be undone.`}
              onBack={() => setStep('actions')}
            />
            <ResponsiveDialogBody>
              <div className="space-y-2">
                <label htmlFor="delete-confirm-input" className="text-sm font-medium">
                  Type <strong>{displayName}</strong> to confirm
                </label>
                <Input
                  id="delete-confirm-input"
                  data-testid="delete-confirm-input"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  placeholder={displayName}
                  autoComplete="off"
                />
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button
                variant="destructive"
                disabled={deleteInput !== displayName}
                onClick={handleDelete}
              >
                Delete Agent & Data
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
