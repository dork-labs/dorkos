/**
 * About — what an agent is called and what it is for (spec
 * `profile-unification` §1.5).
 *
 * **Where an agent gets renamed.** The retired panel renamed inline in its hero;
 * the profile's header is a fixed lockup with no controls in it (§1.2), and a
 * whole pushed page for one text field an operator changes once would be more
 * navigation than the value. So the name sits above the description on the page
 * that is already "who is this agent" — one page, the two things a person
 * writes about an agent.
 *
 * @module features/profile/ui/pages/AboutPage
 */
import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { Button, Input, Skeleton } from '@/layers/shared/ui';
import { deriveRelationship } from '../../lib/profile-relationship';
import { useProfileAgent, type ProfileAgentManifest } from '../../model/use-profile-agent';
import type { ProfilePageContentProps } from './types';

/** A field heading, in the quiet register the rest of the profile uses. */
function FieldLabel({ children }: { children: string }) {
  return (
    <div className="text-muted-foreground text-3xs font-medium tracking-wider uppercase">
      {children}
    </div>
  );
}

/** What an agent can do, as the operator chose to describe it. */
function Capabilities({
  agent,
  onUpdate,
}: {
  agent: ProfileAgentManifest;
  onUpdate: (updates: { capabilities: string[] }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const capabilities = agent.capabilities ?? [];

  function add() {
    const trimmed = draft.trim();
    // A duplicate is not an error worth a message — the chip is already there,
    // which is the whole of what the operator was asking for.
    if (trimmed && !capabilities.includes(trimmed)) {
      onUpdate({ capabilities: [...capabilities, trimmed] });
    }
    setDraft('');
    setAdding(false);
  }

  return (
    <div className="space-y-1">
      <FieldLabel>Capabilities</FieldLabel>
      <div className="flex flex-wrap items-center gap-1.5">
        {capabilities.map((capability) => (
          <span
            key={capability}
            className="bg-accent text-accent-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
          >
            {capability}
            <button
              type="button"
              onClick={() =>
                onUpdate({ capabilities: capabilities.filter((c) => c !== capability) })
              }
              className="hover:text-destructive transition-colors"
              aria-label={`Remove capability ${capability}`}
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        {adding ? (
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add();
              if (event.key === 'Escape') setAdding(false);
            }}
            className="h-6 w-28 text-xs"
            placeholder="capability name"
            aria-label="New capability"
          />
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
            className="text-muted-foreground hover:text-foreground h-auto gap-0.5 px-1 py-0 text-xs"
          >
            <Plus aria-hidden className="size-3" /> Add
          </Button>
        )}
      </div>
    </div>
  );
}

/** One field that commits what you typed on Enter or on leaving it. */
function CommitField({
  label,
  value,
  placeholder,
  multiline,
  testId,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  multiline?: boolean;
  testId: string;
  /**
   * Save what was typed — or **return a sentence to refuse it**, which puts the
   * old value back in the field and says why underneath.
   */
  onCommit: (next: string) => string | void;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [refusal, setRefusal] = useState<string | null>(null);

  // Somebody else moved this field — another window, or the agent itself. Adjust
  // during render rather than in an effect, so the new value never renders for a
  // frame under the old draft.
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === value.trim()) return;
    const refused = onCommit(trimmed);
    if (typeof refused !== 'string') return setRefusal(null);
    // Not left blank and not left saying something that was never stored: the
    // field goes back to what the agent is actually called, and the reason sits
    // under it until the next keystroke.
    setDraft(value);
    setRefusal(refused);
  }

  const className =
    'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none';

  const hint = refusal ? (
    <p role="status" className="text-destructive text-xs">
      {refusal}
    </p>
  ) : null;

  return (
    <div className="space-y-1">
      <FieldLabel>{label}</FieldLabel>
      {multiline ? (
        <textarea
          value={draft}
          rows={4}
          data-testid={testId}
          aria-label={label}
          placeholder={placeholder}
          onChange={(event) => {
            setRefusal(null);
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter commits, Shift+Enter is a new paragraph — the same bargain
            // the composer makes, so the muscle memory carries.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              commit();
            }
          }}
          className={className}
        />
      ) : (
        <input
          value={draft}
          data-testid={testId}
          aria-label={label}
          placeholder={placeholder}
          onChange={(event) => {
            setRefusal(null);
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
          }}
          className={className}
        />
      )}
      {hint}
    </div>
  );
}

/**
 * An agent's name, description and capabilities — editable where they are
 * yours, and plain text where they are not.
 *
 * DorkBot never reaches the editor: its About row is `locked` in the row model
 * (§1.4), so the only way in is a link, and the read-only branch is what answers
 * that. The server would refuse anyway (403 `SYSTEM_PROTECTED`); a control that
 * fails after you use it is what the lock exists to prevent.
 */
export function AboutPage({ member, roster }: ProfilePageContentProps) {
  const { agent, isPending, update } = useProfileAgent(member);
  const editable = deriveRelationship(member, roster) === 'managed';

  if (isPending) return <Skeleton className="h-16 w-full" />;

  if (!editable || !agent) return <ReadOnlyAbout member={member} agent={agent} />;

  return (
    <div className="flex flex-col gap-4" data-slot="profile-about">
      <CommitField
        label="Name"
        value={agent.displayName ?? agent.name}
        placeholder="What you call this agent"
        testId="agent-name-field"
        // An agent with no name is not something this page can save — the
        // roster, the header and every mention of it are drawn from this
        // string. It used to swallow the empty commit and leave the field
        // blank, which looked exactly like a rename that worked.
        onCommit={(displayName) => {
          if (!displayName) return 'An agent needs a name, so this one kept the one it had.';
          update({ displayName });
        }}
      />
      <CommitField
        multiline
        label="Description"
        value={agent.description ?? ''}
        placeholder="What is this agent for?"
        testId="agent-description-field"
        onCommit={(description) => update({ description })}
      />
      <Capabilities agent={agent} onUpdate={update} />
    </div>
  );
}

/** The same facts, for an agent that is not yours to change. */
function ReadOnlyAbout({
  member,
  agent,
}: {
  member: TeamMember;
  agent: ProfileAgentManifest | null;
}) {
  const description = agent?.description?.trim();
  if (!description) {
    return (
      <p className="text-muted-foreground text-sm">
        {member.displayName} hasn’t said what it’s for yet.
      </p>
    );
  }
  return <p className="text-sm leading-relaxed whitespace-pre-wrap">{description}</p>;
}
