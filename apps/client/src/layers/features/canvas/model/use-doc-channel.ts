/** Render one document's owned replay projection without reading private refs during render. */
import { useLayoutEffect, useMemo, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import type { CanvasChannelFrame } from '@dorkos/shared/canvas-channel-schemas';
import { createDocChannelRecovery } from './doc-channel-recovery';
import type { FileSaveBinding } from './file-save/receipt-operation';
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
  fileSaveBinding?: FileSaveBinding;
  fileSaveObservation: 'pending' | 'ready' | 'unavailable';
} {
  const transport = useTransport();
  const [view, setView] = useState<DocChannelView>(() =>
    emptyDocChannelView(documentId, transport)
  );
  const [observation, setObservation] = useState({ documentId, transport, pending: true });
  useLayoutEffect(() => {
    const recovery = createDocChannelRecovery(documentId, transport, setView, (pending) => {
      setObservation({ documentId, transport, pending });
    });
    return () => recovery.dispose();
  }, [documentId, transport]);
  const current =
    view.documentId === documentId && view.transport === transport
      ? view
      : emptyDocChannelView(documentId, transport);
  const channel = useMemo(() => projectDocChannelPort(current), [current]);
  const fileSaveBinding = useMemo(() => {
    const incarnation = current.snapshot?.incarnation;
    const binding = current.binding;
    return incarnation && binding
      ? Object.freeze({
          incarnation: Object.freeze({ ...incarnation }),
          current: () => binding.current('read'),
        })
      : undefined;
  }, [current.snapshot?.incarnation, current.binding]);
  return {
    channel,
    events: current.events,
    frameAdmission: current.frameAdmission,
    fileSaveBinding,
    fileSaveObservation:
      observation.documentId !== documentId ||
      observation.transport !== transport ||
      observation.pending
        ? 'pending'
        : current.available && current.binding?.verified && current.snapshot?.incarnation
          ? 'ready'
          : 'unavailable',
  };
}
