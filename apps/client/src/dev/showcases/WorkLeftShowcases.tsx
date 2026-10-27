import { useEffect, useMemo } from 'react';
import type { HistoryMessage, WorkLeftRunningPart } from '@dorkos/shared/types';
import { DEFAULT_SESSION_STREAM_STATE, useSessionStreamStore } from '@/layers/entities/session';
import { WorkLeftRunningRow } from '@/layers/features/chat/ui/message/rows/WorkLeftRunningRow';
import { WorkLeftPill } from '@/layers/widgets/one-bar/ui/WorkLeftPill';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';

const SESSION_ID = 'showcase-work-left';

const ONE: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [{ taskId: 'deploy', command: 'pnpm run deploy --env production --region us-east-1' }],
};

const SEVERAL: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [
    { taskId: 'tail', command: 'tail -f ~/.dork/logs/dorkos.log' },
    {
      taskId: 'linear',
      command:
        'composio execute LINEAR_CREATE_LINEAR_ISSUE --account dorkos -d @/tmp/lin-c/a.json && composio execute LINEAR_CREATE_LINEAR_ISSUE --account dorkos -d @/tmp/lin-c/b.json',
    },
    { taskId: 'build', command: 'pnpm --filter @dorkos/server build' },
  ],
};

const STUBBORN: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [{ taskId: 'stubborn', command: 'python3 -c "import time; time.sleep(600)"' }],
};

const ENDED: WorkLeftRunningPart = {
  type: 'work_left_running',
  tasks: [
    { taskId: 'tail-done', command: 'tail -f ~/.dork/logs/dorkos.log', ended: 'stopped' },
    { taskId: 'build-done', command: 'pnpm --filter @dorkos/server build', ended: 'completed' },
  ],
};

/**
 * A Stop that left commands running (DOR-3285): the stored line under the
 * stopped turn, each command with its own Stop, and the header pill. The
 * last row's Stop is refused, to show the state a person sees then.
 */
export function WorkLeftShowcases() {
  const transport = useMemo(() => createPlaygroundTransport(), []);
  const refusing = useMemo(
    () => ({ ...transport, stopTask: () => Promise.reject(new Error('refused')) }),
    [transport]
  );
  useEffect(() => {
    const message = { id: 'work-left-showcase', role: 'assistant', content: '', parts: [ONE] };
    useSessionStreamStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [SESSION_ID]: {
          ...DEFAULT_SESSION_STREAM_STATE,
          messages: [message as HistoryMessage],
        },
      },
    }));
  }, []);
  return (
    <PlaygroundSection
      title="Work left running"
      description="A Stop that could not end every command its turn started. The line stays under the stopped turn."
    >
      <TransportProvider transport={transport}>
        <ShowcaseLabel>Header pill</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <WorkLeftPill sessionId={SESSION_ID} />
        </ShowcaseDemo>
        <ShowcaseLabel>One command still running</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <WorkLeftRunningRow sessionId={SESSION_ID} part={ONE} />
        </ShowcaseDemo>
        <ShowcaseLabel>Several commands still running</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <WorkLeftRunningRow sessionId={SESSION_ID} part={SEVERAL} />
        </ShowcaseDemo>
        <ShowcaseLabel>Every command has ended</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <WorkLeftRunningRow sessionId={SESSION_ID} part={ENDED} />
        </ShowcaseDemo>
      </TransportProvider>
      <TransportProvider transport={refusing}>
        <ShowcaseLabel>The command would not stop</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <div data-testid="work-left-refusing">
            <WorkLeftRunningRow sessionId={SESSION_ID} part={STUBBORN} />
          </div>
        </ShowcaseDemo>
      </TransportProvider>
    </PlaygroundSection>
  );
}
