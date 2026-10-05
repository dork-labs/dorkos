import { Button, Notice } from '@dork-labs/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CommunityWireEmailLinkPeek } from '@dorkos/shared/community-wire';
import { describeError, RequestError } from '../api.js';
import { HostPolicyLinks } from '../components/HostLinks.js';
import {
  clearEmailLinkFragment,
  clearLine,
  peekEmailLink,
  readEmailLinkFragment,
} from './links.js';

/** Where a mailed link's page is: looking at the link, ready, or unable to use it. */
export type EmailLinkState =
  | { kind: 'checking' }
  | { kind: 'ready'; peek: CommunityWireEmailLinkPeek }
  | { kind: 'expired' }
  | { kind: 'refused'; message: string }
  | { kind: 'retry'; message: string };

/**
 * Read the token the link carried and look at it once, before anything is used. Nothing happens
 * on load beyond that look, so a mail scanner that opens the page changes nothing; the person
 * presses the button.
 */
export function useEmailLink() {
  // The inline bootstrap already took the token out of the address bar; it lives only here.
  const [first] = useState(readEmailLinkFragment);
  const token = useRef(first);
  const [state, setState] = useState<EmailLinkState>(
    first ? { kind: 'checking' } : { kind: 'expired' }
  );

  useEffect(() => () => clearEmailLinkFragment(), []);

  async function check() {
    const secret = token.current;
    if (!secret) return setState({ kind: 'expired' });
    setState({ kind: 'checking' });
    try {
      const peek = await peekEmailLink(secret);
      // Kept in this page's memory only, until the person presses the button.
      clearEmailLinkFragment();
      setState({ kind: 'ready', peek });
    } catch (cause) {
      setState(failure(cause));
    }
  }

  const started = useRef(false);
  useEffect(() => {
    // Once per page, even where React runs effects twice.
    if (started.current || !token.current) return;
    started.current = true;
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on the token found at load
  }, []);

  /** The link can no longer be used: forget it. */
  function expire() {
    token.current = null;
    clearEmailLinkFragment();
    setState({ kind: 'expired' });
  }

  return { state, setState, token, check, expire };
}

/** What a failed look or use means for the page. */
export function failure(cause: unknown): EmailLinkState {
  if (cause instanceof RequestError && cause.code === 'LINK_EXPIRED') return { kind: 'expired' };
  if (cause instanceof RequestError && cause.code === 'SIGN_IN_REFUSED')
    return { kind: 'refused', message: cause.message };
  return { kind: 'retry', message: describeError(cause) };
}

/** The frame every mailed-link page shares: one card, its heading, and the host's links. */
export function EmailLinkPage({
  title,
  busy,
  children,
}: {
  title: string;
  busy: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef(title);
  useEffect(() => {
    if (shown.current === title) return;
    shown.current = title;
    heading.current?.focus();
  }, [title]);
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <main className="auth-card" aria-busy={busy}>
        <p className="eyebrow">DorkOS Space</p>
        <h1 ref={heading} tabIndex={-1} className="mb-3">
          {title}
        </h1>
        {children}
        <HostPolicyLinks />
      </main>
    </div>
  );
}

/** What using the link ends, listed before the person submits. */
export function ClearsList({ lead, clears }: { lead: string; clears: readonly string[] }) {
  if (!clears.length) return null;
  return (
    <div className="mb-4">
      <p className="muted mb-1">{lead}</p>
      <ul className="muted list-disc pl-5">
        {clears.map((key) => (
          <li key={key}>{clearLine(key)}</li>
        ))}
      </ul>
    </div>
  );
}

/** A warning that this browser is signed in as someone else than the link's account. */
export function OtherAccountNotice({
  peek,
  text,
}: {
  peek: CommunityWireEmailLinkPeek;
  text: (other: string) => string;
}) {
  const other = peek.signedInAs?.email;
  if (!other || other.toLowerCase() === peek.email.toLowerCase()) return null;
  return (
    // The shared Notice has no warning tone; this is the one that draws the eye.
    <Notice tone="error" role="status" className="mb-4">
      {text(other)}
    </Notice>
  );
}

/** The states every page shows the same way: checking, try again, refused. */
export function CommonStates({ state, onRetry }: { state: EmailLinkState; onRetry: () => void }) {
  if (state.kind === 'checking') return <p role="status">Checking your link…</p>;
  if (state.kind === 'refused')
    return (
      <Notice role="alert" tone="error">
        {state.message}
      </Notice>
    );
  if (state.kind === 'retry')
    return (
      <>
        <Notice role="alert" tone="error" className="mb-4">
          {state.message}
        </Notice>
        <Button variant="outline" type="button" onClick={onRetry}>
          Try again
        </Button>
      </>
    );
  return null;
}

/** Leave the link's page for the app, signed in. */
export function continueToApp() {
  window.location.assign('/');
}
