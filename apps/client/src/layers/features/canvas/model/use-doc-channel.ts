/** Render one document's owned replay projection without reading private refs during render. */
import { useLayoutEffect, useMemo, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import type { CanvasChannelFrame } from '@dorkos/shared/canvas-channel-schemas';
import { createDocChannelRecovery } from './doc-channel-recovery';
import {
  emptyDocChannelView,
  projectDocChannelPort,
  type DocChannelView,
  type NativeFrameAdmission,
} from './doc-channel-view';

/** Keep loading/refused document actions attached to their own lifetime. */
export function useDocChannel(documentId: string): {
  channel: WidgetChannelPort;
  events: CanvasChannelFrame[];
  frameAdmission?: NativeFrameAdmission;
} {
  const transport = useTransport();
  const [view, setView] = useState<DocChannelView>(() =>
    emptyDocChannelView(documentId, transport)
  );
  useLayoutEffect(() => {
    const recovery = createDocChannelRecovery(documentId, transport, setView);
    return () => recovery.dispose();
  }, [documentId, transport]);
  const current =
    view.documentId === documentId && view.transport === transport
      ? view
      : emptyDocChannelView(documentId, transport);
  const channel = useMemo(() => projectDocChannelPort(current), [current]);
  return { channel, events: current.events, frameAdmission: current.frameAdmission };
}
