import { useEffect } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useComputer, releaseComputerViewerControl } from '@/layers/entities/computer';
import {
  useAppStore,
  useTransport,
  useIsBelowDesktop,
  type PipContent,
} from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { ComputerViewer } from './ComputerViewer';

type ComputerContent = Extract<PipContent, { kind: 'computer' }>;

/** The computer's panel view, shown only for the agent bound to it. */
export function ComputerPanelView() {
  const computer = useComputer();
  const pip = useAppStore((s) => s.pipContent);
  const closePip = useAppStore((s) => s.closePip);
  const openPip = useAppStore((s) => s.openPip);
  const transport = useTransport();
  const status = computer.data;
  const overlay = useIsBelowDesktop();
  if (!status?.cwd) return <ComputerUnavailable />;
  const content: ComputerContent = {
    kind: 'computer',
    computerId: status.id,
    generation: status.generation,
    cwd: status.cwd,
    title: status.name,
    agentPath: status.cwd.replace(/\/workspace\/?$/, ''),
  };
  if (
    pip?.kind === 'computer' &&
    pip.computerId === content.computerId &&
    pip.cwd === content.cwd
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground text-sm">Viewing in PiP.</p>
        <Button
          variant="outline"
          onClick={() => {
            void releaseComputerViewerControl(transport);
            closePip();
          }}
        >
          Bring back
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end px-3 pt-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Pop computer out"
          onClick={() => {
            void releaseComputerViewerControl(transport);
            openPip(content);
            if (overlay) useAppStore.getState().setRightPanelOpen(false);
          }}
        >
          <ArrowUpRight className="size-4" />
        </Button>
      </div>
      <ComputerResourceBody content={content} />
    </div>
  );
}

/** A pinned computer view that never follows the ambient chat or agent. */
export function ComputerPipView({ content }: { content: ComputerContent }) {
  const transport = useTransport();
  const closePip = useAppStore((s) => s.closePip);
  const setAgentPath = useAppStore((s) => s.setExplicitAgentPath);
  const requestPanel = useAppStore((s) => s.requestRightPanel);
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (
          previous.pipContent?.kind === 'computer' &&
          (state.pipContent !== previous.pipContent ||
            (!previous.pipMinimized && state.pipMinimized))
        ) {
          void releaseComputerViewerControl(transport);
        }
      }),
    [transport]
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end px-3 pt-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Return computer to panel"
          onClick={() => {
            void releaseComputerViewerControl(transport);
            closePip();
            setAgentPath(content.agentPath);
            requestPanel('computer', content.agentPath);
          }}
        >
          <ArrowDownLeft className="size-4" />
        </Button>
      </div>
      <ComputerResourceBody content={content} pinned />
    </div>
  );
}

/** Lifecycle state is distinct from a frame failure; stale frames are never shown as live. */
function ComputerResourceBody({
  content,
  pinned = false,
}: {
  content: ComputerContent;
  pinned?: boolean;
}) {
  const computer = useComputer();
  const openPip = useAppStore((s) => s.openPip);
  const status = computer.data;
  if (!status || computer.isError)
    return <ComputerUnavailable reconnect={() => void computer.refetch()} />;
  if (status.id !== content.computerId || status.cwd !== content.cwd)
    return <ComputerUnavailable />;
  if (status.phase !== 'ready' || !status.ready) {
    return (
      <ComputerUnavailable
        label={status.phase === 'stopped' ? 'Computer stopped.' : 'Computer unavailable.'}
        reconnect={() => void computer.refetch()}
      />
    );
  }
  if (pinned && status.generation !== content.generation) {
    return (
      <ComputerUnavailable
        label="Computer restarted."
        reconnect={() => openPip({ ...content, generation: status.generation })}
      />
    );
  }
  return <ComputerViewer generation={status.generation} />;
}

function ComputerUnavailable({
  label = 'Couldn’t reach the computer.',
  reconnect,
}: {
  label?: string;
  reconnect?: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p role="status" className="text-muted-foreground text-sm">
        {label}
      </p>
      {reconnect && (
        <Button variant="outline" onClick={reconnect}>
          Reconnect
        </Button>
      )}
    </div>
  );
}
