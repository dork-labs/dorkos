import { MessageList } from '@/layers/features/chat/ui/MessageList';
import { MessageCircle } from 'lucide-react';
import type { TextEffectConfig } from '@/layers/shared/lib';
import type { SimulatorResult } from './use-simulator';

interface SimulatorChatPanelProps {
  sim: SimulatorResult;
  textEffect?: TextEffectConfig;
}

/** Mirrors ChatPanel layout with real MessageList, powered by simulator state instead of useChatSession. */
export function SimulatorChatPanel({ sim, textEffect }: SimulatorChatPanelProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col">
      <div className="relative min-h-0 flex-1">
        {sim.messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-muted-foreground text-sm">Press play to start the simulation</p>
              <p className="text-muted-foreground/60 mt-1 text-xs">
                Or use Step to advance one step at a time
              </p>
            </div>
          </div>
        ) : (
          <MessageList
            messages={sim.messages}
            sessionId="simulator-session"
            status={sim.status}
            isTextStreaming={sim.isTextStreaming}
            isWaitingForUser={sim.isWaitingForUser}
            waitingType={sim.waitingType}
            permissionMode="default"
            activeToolCallId={null}
            onToolRef={() => {}}
            onToolDecided={() => {}}
            onRetry={() => {}}
            textEffect={textEffect}
          />
        )}
      </div>

      {/* Read-only input area — visible but non-functional */}
      <div className="border-t px-4 py-3">
        <div className="bg-muted/50 flex items-center gap-2 rounded-lg border px-3 py-2.5">
          <MessageCircle className="text-muted-foreground/40 size-4" />
          <span className="text-muted-foreground/40 text-sm">Simulator mode — input disabled</span>
        </div>
      </div>
    </div>
  );
}
