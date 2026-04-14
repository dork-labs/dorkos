import { MoreVertical, ShieldBan, ShieldCheck, Unplug, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/layers/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import { cn } from '@/layers/shared/lib';
import {
  useUnregisterAgent,
  useRegisterAgent,
  useDenyAgent,
  useClearDenial,
  useDeniedAgents,
} from '@/layers/entities/mesh';
import { useAgentHubContext } from '../model/agent-hub-context';

interface AgentManagementMenuProps {
  className?: string;
  onDeleteRequest: () => void;
}

/**
 * Kebab dropdown menu with management actions for the current agent:
 * deny/block, unregister (with undo toast), and delete agent & data.
 *
 * Destructive items are hidden for system agents.
 */
export function AgentManagementMenu({ className, onDeleteRequest }: AgentManagementMenuProps) {
  const { agent, projectPath } = useAgentHubContext();
  const unregisterAgent = useUnregisterAgent();
  const registerAgent = useRegisterAgent();
  const denyAgent = useDenyAgent();
  const clearDenial = useClearDenial();
  const { data: deniedData } = useDeniedAgents();

  const isSystem = agent.isSystem === true;
  const isDenied = deniedData?.denied?.some((d) => d.path === projectPath) ?? false;
  const displayName = agent.displayName ?? agent.name;

  function handleToggleDeny() {
    if (isDenied) {
      clearDenial.mutate(projectPath);
    } else {
      denyAgent.mutate({ path: projectPath, reason: 'Blocked via Agent Hub' });
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
      },
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('size-7 p-0', className)}
          aria-label="Agent management actions"
        >
          <MoreVertical className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!isSystem && (
          <>
            <DropdownMenuItem onClick={handleToggleDeny}>
              {isDenied ? (
                <>
                  <ShieldCheck className="mr-2 size-3.5" />
                  Unblock
                </>
              ) : (
                <>
                  <ShieldBan className="mr-2 size-3.5" />
                  Block
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUnregister}>
              <Unplug className="mr-2 size-3.5" />
              Unregister
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDeleteRequest}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 size-3.5" />
              Delete Agent &amp; Data
            </DropdownMenuItem>
          </>
        )}
        {isSystem && (
          <DropdownMenuItem disabled className="text-muted-foreground">
            System agent — no actions available
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
