import { useEffect } from 'react';
import { useAppStore } from '@/layers/shared/model';

/**
 * Sync chat state (streaming, waiting, active form, text streaming) to the
 * global app store so other features (e.g. status bar, sidebar, scan line)
 * can react without prop drilling.
 */
export function useChatStatusSync(
  status: string,
  isWaitingForUser: boolean,
  activeForm: string | null,
  isTextStreaming: boolean,
): void {
  const setIsStreaming = useAppStore((s) => s.setIsStreaming);
  const setIsWaitingForUser = useAppStore((s) => s.setIsWaitingForUser);
  const setActiveForm = useAppStore((s) => s.setActiveForm);
  const setIsTextStreaming = useAppStore((s) => s.setIsTextStreaming);

  useEffect(() => {
    setIsStreaming(status === 'streaming');
    return () => setIsStreaming(false);
  }, [status, setIsStreaming]);

  useEffect(() => {
    setIsWaitingForUser(isWaitingForUser);
    return () => setIsWaitingForUser(false);
  }, [isWaitingForUser, setIsWaitingForUser]);

  useEffect(() => {
    setActiveForm(activeForm);
    return () => setActiveForm(null);
  }, [activeForm, setActiveForm]);

  useEffect(() => {
    setIsTextStreaming(isTextStreaming);
    return () => setIsTextStreaming(false);
  }, [isTextStreaming, setIsTextStreaming]);
}
