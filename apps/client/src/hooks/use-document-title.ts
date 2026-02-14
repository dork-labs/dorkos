import { useEffect, useRef } from 'react';
import { hashToEmoji } from '@/lib/favicon-utils';

interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
  isStreaming: boolean;
  isWaitingForUser: boolean;
}

function buildTitle(cwd: string, activeForm: string | null, prefix: string): string {
  const emoji = hashToEmoji(cwd);
  const dirName = cwd.split('/').filter(Boolean).pop() ?? cwd;
  let title = `${prefix}${emoji} ${dirName}`;
  if (activeForm) {
    const truncated =
      activeForm.length > 40
        ? activeForm.slice(0, 40) + '\u2026'
        : activeForm;
    title += ` \u2014 ${truncated}`;
  }
  title += ' \u2014 DorkOS';
  return title;
}

export function useDocumentTitle({ cwd, activeForm, isStreaming, isWaitingForUser }: UseDocumentTitleOptions) {
  const isTabHiddenRef = useRef(document.hidden);
  const hasUnseenResponseRef = useRef(false);
  const wasStreamingRef = useRef(isStreaming);

  // Refs to keep visibility handler in sync with latest prop values
  const cwdRef = useRef(cwd);
  const activeFormRef = useRef(activeForm);
  const isWaitingForUserRef = useRef(isWaitingForUser);
  cwdRef.current = cwd;
  activeFormRef.current = activeForm;
  isWaitingForUserRef.current = isWaitingForUser;

  // Track tab visibility and clear 🏁 on return
  useEffect(() => {
    const handler = () => {
      isTabHiddenRef.current = document.hidden;
      if (!document.hidden && hasUnseenResponseRef.current) {
        hasUnseenResponseRef.current = false;
        // Rebuild title — preserve 🔔 if still waiting
        if (cwdRef.current) {
          const prefix = isWaitingForUserRef.current ? '🔔 ' : '';
          document.title = buildTitle(cwdRef.current, activeFormRef.current, prefix);
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Detect streaming→idle transition while tab is hidden
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && isTabHiddenRef.current) {
      hasUnseenResponseRef.current = true;
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Build title (runs on all relevant state changes)
  useEffect(() => {
    if (!cwd) {
      document.title = 'DorkOS';
      return;
    }

    // Compute prefix (priority: 🔔 > 🏁 > none)
    let prefix = '';
    if (isWaitingForUser) {
      prefix = '🔔 ';
    } else if (hasUnseenResponseRef.current) {
      prefix = '🏁 ';
    }

    document.title = buildTitle(cwd, activeForm, prefix);
  }, [cwd, activeForm, isStreaming, isWaitingForUser]);
}
