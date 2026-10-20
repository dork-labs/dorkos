import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, Clock, RotateCw } from 'lucide-react';
import type { SignInLanding } from '@dorkos/shared/sign-in-landing';
import { appRoutes } from '@/layers/shared/lib';
import { Button, Notice, Spinner } from '@/layers/shared/ui';
import {
  closeTabHint,
  GONE_COPY,
  landingCopy,
  RETRY_FAILED_COPY,
  UNREACHABLE_COPY,
  type LandingCopy,
} from '../lib/landing-copy';
import { opensDesktopOnLoad, returnTarget, type ReturnTarget } from '../lib/return-target';
import {
  useLandingAgentName,
  useRetrySignIn,
  useSignInLanding,
} from '../model/use-sign-in-landing';
import { ConnectionMark } from './ConnectionMark';

/** How long "Opening DorkOS…" shows before the page settles on its close-tab line. */
const OPENING_NOTE_MS = 2500;

interface SignInLandingPageProps {
  /** The `landing` id from the URL. */
  landingId: string;
}

/**
 * The page a browser lands on after signing in to a service: what happened,
 * in plain words, and the way back to the right DorkOS.
 *
 * Patterns borrowed: Linear's and Figma's "you can close this tab" (the page
 * never pretends it can close itself), Slack's and Raycast's automatic hand-off
 * to the desktop app with a button for when the hand-off is blocked, Vercel's
 * one-line "what happens next", and the GitHub CLI's naming of the exact thing
 * just authorized.
 */
export function SignInLandingPage({ landingId }: SignInLandingPageProps) {
  const landing = useSignInLanding(landingId);

  if (landing.isPending && landingId.length > 0) {
    return (
      <LandingFrame title="Finishing sign-in">
        <div className="flex justify-center py-10">
          <Spinner size="md" label="Finishing sign-in" className="text-muted-foreground" />
        </div>
      </LandingFrame>
    );
  }
  if (!landing.data) {
    // Only a 404 means the record is gone; anything else is DorkOS not answering.
    const status = (landing.error as { status?: number } | null)?.status;
    const gone = landingId.length === 0 || status === 404;
    return <MissingLanding copy={gone ? GONE_COPY : UNREACHABLE_COPY} />;
  }
  return <Landing landing={landing.data} />;
}

/** No record to show (gone, or DorkOS did not answer): say which and point home. */
function MissingLanding({ copy }: { copy: LandingCopy }) {
  return (
    <LandingFrame title={copy.heading}>
      <div className="bg-muted mx-auto flex size-12 items-center justify-center rounded-xl border">
        <Clock className="text-muted-foreground size-5" />
      </div>
      <Heading copy={copy} />
      <div className="mt-6 flex flex-col gap-2">
        <Button asChild variant="outline">
          <Link {...appRoutes.home()}>Back to DorkOS</Link>
        </Button>
      </div>
    </LandingFrame>
  );
}

function Landing({ landing }: { landing: SignInLanding }) {
  const agentName = useLandingAgentName(landing.agentId);
  const retry = useRetrySignIn(landing.id);
  const target = returnTarget(landing);
  // Try again found the person already signed in: show the finished state.
  const connected = landing.status === 'connected' || retry.data?.kind === 'connected';
  const copy = landingCopy(
    connected ? { ...landing, status: 'connected', reason: undefined } : landing,
    agentName
  );
  const opening = useDesktopHandOff(landing, target);

  return (
    <LandingFrame title={copy.heading}>
      <ConnectionMark
        serviceName={landing.serviceName}
        tone={connected ? 'connected' : landing.reason === 'failed' ? 'error' : 'neutral'}
      />
      <Heading copy={copy} />

      <div className="mt-6 flex flex-col gap-2">
        {!connected && landing.canRetry && (
          <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? <Spinner /> : <RotateCw />}
            Try again
          </Button>
        )}
        <Button asChild variant={connected ? 'default' : 'outline'}>
          <a href={target.href}>
            {target.surface === 'desktop' ? 'Open DorkOS' : 'Back to DorkOS'}
            {target.surface === 'desktop' && <ArrowUpRight />}
          </a>
        </Button>
      </div>

      {retry.isError && (
        <Notice tone="error" className="mt-4 text-left">
          {RETRY_FAILED_COPY}
        </Notice>
      )}

      <p className="text-muted-foreground mt-4 text-xs" aria-live="polite">
        {opening ? 'Opening DorkOS…' : closeTabHint(target.surface)}
      </p>
    </LandingFrame>
  );
}

/**
 * Hand a finished desktop sign-in back to the app once, as the page loads, and
 * report whether the "Opening DorkOS…" note is still showing.
 */
function useDesktopHandOff(landing: SignInLanding, target: ReturnTarget): boolean {
  const handedOff = useRef(false);
  const auto = opensDesktopOnLoad(landing);
  const [opening, setOpening] = useState(auto);
  useEffect(() => {
    if (!auto) return;
    // The link fires once, even when StrictMode runs this effect twice; the
    // note's timer is set on every run, so the one that survives clears it.
    if (!handedOff.current) {
      handedOff.current = true;
      window.location.href = target.href;
    }
    const timer = window.setTimeout(() => setOpening(false), OPENING_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [auto, target.href]);
  return opening;
}

function Heading({ copy }: { copy: LandingCopy }) {
  return (
    <div className="mt-6 flex flex-col gap-1.5">
      <h1 className="text-lg font-semibold tracking-tight text-balance">{copy.heading}</h1>
      <p className="text-muted-foreground text-sm text-pretty">{copy.body}</p>
    </div>
  );
}

/** The centred card every state sits in, and the tab's title. */
function LandingFrame({ title, children }: { title: string; children: ReactNode }) {
  const still = useReducedMotion() ?? false;
  useEffect(() => {
    document.title = `${title} · DorkOS`;
  }, [title]);
  return (
    <main className="bg-background flex min-h-dvh w-full items-center justify-center p-4 sm:p-6">
      <motion.div
        className="bg-card shadow-elevated w-full max-w-sm rounded-2xl border px-6 py-8 text-center sm:px-8"
        initial={still ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </main>
  );
}
