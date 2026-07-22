/**
 * Dashboard composer — the hero action at the top of the dashboard.
 *
 * The same question DorkBot's onboarding hand-off asks ("What are we building
 * today?"), followed by a live composer. Sending a message opens a real session
 * with the default agent through the `first-message` seam (ADR 260722-111316):
 * a fresh session id is registered with the typed words, then the route changes
 * to `/session`, where the message sends as the user's own turn. Mirrors the
 * onboarding dissolve's record shape.
 *
 * @module widgets/dashboard/ui/DashboardComposerSection
 */
import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAgentBirthStore, type AgentBirthRecord } from '@/layers/shared/model';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { ChatInput } from '@/layers/features/chat';
import { useDefaultAgentSession } from '@/layers/entities/config';

/** The composer section rendered first in the dashboard body. */
export function DashboardComposerSection() {
  const navigate = useNavigate();
  const { defaultAgentDir, defaultAgentDisplayName, defaultAgentIdentity, isDefaultAgentResolved } =
    useDefaultAgentSession();
  const [value, setValue] = useState('');

  const handleSubmit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    // Never start a session with the config-composed fallback path — the events
    // stream 403s on the unresolved tilde. Wait for the registry-resolved dir.
    if (!isDefaultAgentResolved) return;

    const sessionId = crypto.randomUUID();
    const record: Omit<AgentBirthRecord, 'fired'> = {
      kind: 'first-message',
      name: defaultAgentIdentity.name,
      displayName: defaultAgentIdentity.displayName,
      agentId: defaultAgentIdentity.agentId,
      icon: defaultAgentIdentity.icon,
      color: defaultAgentIdentity.color,
      bornAt: new Date().toISOString(),
      path: defaultAgentDir,
      runtime: defaultAgentIdentity.runtime,
      kickoffMessage: text,
    };
    useAgentBirthStore.getState().register(sessionId, record);
    setValue('');
    navigate({ to: '/session', search: { dir: defaultAgentDir, session: sessionId } });
  }, [value, isDefaultAgentResolved, defaultAgentDir, defaultAgentIdentity, navigate]);

  return (
    <section data-testid={TOUR_ANCHORS.dashboardComposer}>
      <h2 className="text-foreground mb-3 text-lg font-semibold tracking-tight">
        What are we building today?
      </h2>
      <ChatInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        isStreaming={false}
        canSubmit={isDefaultAgentResolved}
        placeholder={`Message ${defaultAgentDisplayName}…`}
      />
    </section>
  );
}
