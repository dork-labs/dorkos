import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Menu, Plus, Settings2, X } from 'lucide-react';
import { Admission, type AdmissionResume } from './components/Admission.js';
import { ChannelView } from './components/Channel.js';
import { Manage } from './components/Manage.js';
import { SignedOutPanel } from './components/SignOut.js';
import { returnToChooserWithNotice } from './components/CommunityChooser.js';
import { rememberCommunity } from './remembered-community.js';
import { describeError, hostRequest, RequestError, request } from './api.js';
import { readInviteFragment } from './invite-fragment.js';
import { readPendingAdmission } from './admission.js';
import {
  parseCommunitySettingsPath,
  type CommunityWireMembershipSummary,
} from '@dorkos/shared/community-wire';
import type { Channel, Community, CommunityLifecycle, Me } from './types.js';

function isCommunityUnavailable(cause: unknown): cause is RequestError {
  return (
    cause instanceof RequestError &&
    ['COMMUNITY_UNAVAILABLE', 'COMMUNITY_SUSPENDED', 'COMMUNITY_DELETION_PENDING'].includes(
      cause.code
    )
  );
}

/** Render the signed-in community shell or the admission path. */
export function CommunityApp() {
  const [inviteToken, setInviteToken] = useState(() => readInviteFragment());
  const inviteTokenRef = useRef(inviteToken);
  const [community, setCommunity] = useState<Community | null>(null);
  const [communityLifecycle, setCommunityLifecycle] = useState<CommunityLifecycle | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [unadmitted, setUnadmitted] = useState(false);
  const [hostSignIn, setHostSignIn] = useState(false);
  const [admissionComplete, setAdmissionComplete] = useState(false);
  const [admissionResume, setAdmissionResume] = useState<AdmissionResume | null>(null);
  const joinedHeading = useRef<HTMLHeadingElement>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A DorkOS app opens `/c/<id>/settings[/<section>]` for invite, leave and
  // settings: those need this person's own sign-in, never the installation's.
  const [settingsRoute] = useState(() => parseCommunitySettingsPath(window.location.pathname));
  const [settings, setSettings] = useState(settingsRoute !== null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [signedOut, setSignedOut] = useState(false);
  const selected = useMemo(
    () => channels.find((channel) => channel.id === selectedId) ?? null,
    [channels, selectedId]
  );
  const returnToChooser = useCallback(() => {
    if (/^\/c\/[^/]+(?:\/|$)/u.test(window.location.pathname)) returnToChooserWithNotice();
  }, []);
  const eraseInviteToken = useCallback(() => {
    inviteTokenRef.current = null;
    setInviteToken(null);
  }, []);
  const refreshChannels = useCallback(async () => {
    try {
      const body = await request<{ channels: Channel[] }>('/api/v1/channels');
      setChannels(body.channels);
      setSelectedId((current) =>
        current && body.channels.some((channel) => channel.id === current)
          ? current
          : ((body.channels.find((channel) => channel.joined) ?? body.channels[0])?.id ?? null)
      );
    } catch (cause) {
      if (
        cause instanceof RequestError &&
        (cause.status === 401 || cause.status === 403 || isCommunityUnavailable(cause))
      ) {
        returnToChooser();
        setMe(null);
      } else setError(describeError(cause));
    }
  }, [returnToChooser]);
  const refreshCurrentMember = useCallback(async () => {
    const current = await request<Me>('/api/v1/me');
    setMe(current);
    return current.member;
  }, []);
  const refreshCommunityLifecycle = useCallback(
    async (communityId: string) => {
      const body = await hostRequest<{ memberships: CommunityWireMembershipSummary[] }>(
        '/api/v1/memberships'
      );
      const membership = body.memberships.find(
        (candidate) => candidate.communityId === communityId
      );
      if (!membership) {
        returnToChooser();
        return null;
      }
      if (membership.lifecycle !== 'active' && membership.lifecycle !== 'archived') {
        returnToChooser();
        return null;
      }
      setCommunityLifecycle(membership.lifecycle);
      return membership.lifecycle;
    },
    [returnToChooser]
  );
  useEffect(() => {
    if (!me || !community) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshCommunityLifecycle(community.id).catch((cause: unknown) => {
          if (cause instanceof RequestError && cause.status === 401) returnToChooser();
          else setError(describeError(cause));
        });
        void refreshChannels();
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [community, me?.member.memberId, refreshChannels, refreshCommunityLifecycle]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const metadata = await request<Community>('/api/v1/community');
        if (!active) return;
        setCommunity(metadata);
        rememberCommunity(metadata.id);
        if (window.location.pathname === '/' || window.location.pathname === '/join')
          window.history.replaceState(null, '', `/c/${metadata.id}`);
        const joinPath = /\/join$/u.test(window.location.pathname);
        if (inviteTokenRef.current && joinPath) {
          setMe(null);
          setUnadmitted(false);
          return;
        }
        // A reload or sign-in return on the clean join URL resumes from the HttpOnly join
        // attempt, never from anything the page kept. With none left, the person either
        // already joined (and enters below) or must open the invitation again.
        if (joinPath) {
          try {
            const pending = await readPendingAdmission();
            if (!active) return;
            if (pending) {
              setAdmissionResume({ kind: 'pending', pending });
              setMe(null);
              return;
            }
            setAdmissionResume({ kind: 'lost' });
          } catch (cause) {
            if (!active) return;
            if (cause instanceof RequestError && cause.status === 409) {
              setAdmissionResume({ kind: 'refused', cause });
              setMe(null);
              return;
            }
            throw cause;
          }
        }
        try {
          const current = await request<Me>('/api/v1/me');
          if (!active) return;
          const lifecycle = await refreshCommunityLifecycle(metadata.id);
          if (!active || !lifecycle) return;
          setMe(current);
          setUnadmitted(false);
          // Joined: the join URL has nothing left to resume, so a later reload enters directly.
          if (joinPath) window.history.replaceState(null, '', `/c/${metadata.id}`);
          await refreshChannels();
        } catch (cause) {
          if (!active) return;
          if (cause instanceof RequestError && (cause.status === 401 || cause.status === 403)) {
            // A signed-in non-member on the join URL stays to read why membership was not
            // added; anywhere else the tenant is simply not theirs to enter.
            if (cause.status === 403 && !inviteTokenRef.current && !joinPath) returnToChooser();
            setMe(null);
            setUnadmitted(cause.status === 403);
          } else if (isCommunityUnavailable(cause)) {
            returnToChooser();
            setMe(null);
          } else setError(describeError(cause));
        }
      } catch (cause) {
        if (!active) return;
        if (cause instanceof RequestError && cause.status === 404) {
          // An unknown tenant ID gets the same answer as one this account cannot enter; only
          // a host with no community at all offers first-host setup.
          if (/^\/c\//u.test(window.location.pathname)) returnToChooser();
          setCommunity(null);
          setMe(null);
        } else if (cause instanceof RequestError && cause.code === 'COMMUNITY_SELECTION_REQUIRED') {
          setHostSignIn(true);
          setMe(null);
        } else if (isCommunityUnavailable(cause)) {
          returnToChooser();
          setMe(null);
        } else setError(describeError(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [revision, refreshChannels, refreshCommunityLifecycle, returnToChooser]);
  // The join form that held focus is gone; start keyboard and screen-reader users at the
  // confirmation that replaced it.
  useEffect(() => {
    if (admissionComplete) joinedHeading.current?.focus();
  }, [admissionComplete]);
  const onChanged = useCallback(() => {
    if (community)
      void refreshCommunityLifecycle(community.id).catch((cause: unknown) => {
        if (cause instanceof RequestError && cause.status === 401) returnToChooser();
        else setError(describeError(cause));
      });
    void refreshChannels();
  }, [community, refreshChannels, refreshCommunityLifecycle, returnToChooser]);
  if (signedOut) return <SignedOutPanel />;
  if (loading)
    return (
      <main className="grid min-h-dvh place-items-center">
        <div role="status" className="panel p-6">
          <p className="eyebrow">DorkOS Community</p>
          <p className="mb-0">Opening your community…</p>
        </div>
      </main>
    );
  if (error && !me)
    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <div className="panel max-w-md p-6">
          <h1 className="text-xl">We could not open this community.</h1>
          <p role="alert" className="muted">
            {error}
          </p>
          <button className="button primary" onClick={() => setRevision((old) => old + 1)}>
            Try again
          </button>
        </div>
      </main>
    );
  if (admissionComplete && community)
    return (
      <main className="grid min-h-dvh place-items-center p-5">
        <section className="panel max-w-md p-6" aria-labelledby="community-joined-title">
          <p className="eyebrow">Membership added</p>
          <h1 id="community-joined-title" ref={joinedHeading} tabIndex={-1}>
            You’re in {community.name}.
          </h1>
          <p className="muted">
            Open the community now, or connect a DorkOS installation as a separate next step.
          </p>
          <button
            className="button primary"
            onClick={() => {
              setAdmissionComplete(false);
              setRevision((old) => old + 1);
            }}
          >
            Open community
          </button>
          <div className="notice mt-4">
            <strong>Connect this DorkOS installation</strong>
            <p className="small muted mb-0">
              In the DorkOS app, open Connections, then Messaging, then Communities. Each
              installation needs its own approval.
            </p>
          </div>
        </section>
      </main>
    );
  if (!me)
    return (
      <Admission
        community={community}
        hostSignIn={hostSignIn}
        inviteToken={inviteToken}
        resume={admissionResume}
        unadmitted={unadmitted}
        onInviteExchanged={eraseInviteToken}
        onAdmitted={(joined) => {
          if (hostSignIn) {
            window.location.assign('/');
            return;
          }
          eraseInviteToken();
          setAdmissionResume(null);
          if (joined) setAdmissionComplete(true);
          else setRevision((old) => old + 1);
        }}
      />
    );
  const leaveSettingsPath = () => {
    if (community && parseCommunitySettingsPath(window.location.pathname))
      window.history.replaceState(null, '', `/c/${community.id}`);
  };
  const choose = (id: string) => {
    setSelectedId(id);
    setSettings(false);
    setMobileOpen(false);
    leaveSettingsPath();
  };
  const readOnly = communityLifecycle === 'archived';
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Community channels">
        <div className="sidebar-head">
          <p className="eyebrow">DorkOS Community</p>
          <h1>{community?.name ?? 'Your community'}</h1>
          <p className="small muted mb-0">Signed in as {me.member.displayName}</p>
          <button className="button mt-3 w-full" onClick={() => window.location.assign('/')}>
            Switch community
          </button>
        </div>
        <div className="sidebar-list">
          <p className="sidebar-section">Your channels</p>
          {channels.filter((channel) => channel.joined).length === 0 && (
            <p className="small muted px-3">You have not joined a channel yet.</p>
          )}
          {channels
            .filter((channel) => channel.joined)
            .map((channel) => (
              <button
                key={channel.id}
                className={`nav-item ${!settings && selectedId === channel.id ? 'active' : ''}`}
                onClick={() => choose(channel.id)}
              >
                <span className="row min-w-0">
                  <Hash size={15} />
                  <span className="truncate">{channel.name}</span>
                </span>
                {channel.unreadCount > 0 && (
                  <span className="badge" aria-label={`${channel.unreadCount} unread`}>
                    {channel.unreadCount}
                  </span>
                )}
              </button>
            ))}
          {!readOnly && channels.some((channel) => !channel.joined) && (
            <>
              <p className="sidebar-section">Explore</p>
              {channels
                .filter((channel) => !channel.joined)
                .map((channel) => (
                  <button
                    key={channel.id}
                    className={`nav-item ${!settings && selectedId === channel.id ? 'active' : ''}`}
                    onClick={() => choose(channel.id)}
                  >
                    <span className="row">
                      <Plus size={15} />
                      {channel.name}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
        <div className="border-t border-[var(--line)] p-3">
          <button
            className={`nav-item ${settings ? 'active' : ''}`}
            onClick={() => {
              setSettings(true);
              setMobileOpen(false);
            }}
          >
            <span className="row">
              <Settings2 size={18} /> Settings
            </span>
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close channel navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <section className="main-area">
        <header className="topbar">
          <div className="row">
            <button
              className="button ghost mobile-only"
              aria-label="Open channel navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div>
              <p className="eyebrow mb-0">
                {readOnly
                  ? 'Archived community'
                  : settings
                    ? 'Settings'
                    : selected?.visibility === 'private'
                      ? 'Private channel'
                      : 'Channel'}
              </p>
              <h2>{settings ? 'Your space' : selected ? `# ${selected.name}` : 'Welcome'}</h2>
            </div>
          </div>
          {selected && !settings && (
            <div className="row">
              <span className="small muted hidden sm:inline">
                {selected.archived ? 'Archived' : selected.joined ? 'Joined' : 'Explore'}
              </span>
              <button className="button" aria-label="Manage" onClick={() => setSettings(true)}>
                <Settings2 size={16} />
                <span className="hidden sm:inline">Manage</span>
              </button>
            </div>
          )}
          {settings && (
            <button
              className="button"
              onClick={() => {
                setSettings(false);
                leaveSettingsPath();
              }}
            >
              <X size={16} /> Close
            </button>
          )}
        </header>
        {error && (
          <div className="notice error m-3" role="alert">
            {error}
          </div>
        )}
        {settings ? (
          <Manage
            communityId={community!.id}
            communityName={community!.name}
            me={me.member}
            channels={channels}
            initialSection={settingsRoute?.section ?? null}
            selectedChannel={selected}
            onChanged={onChanged}
            onCurrentMemberChanged={refreshCurrentMember}
            onLeft={() => {
              window.location.assign('/');
            }}
            onSignedOut={() => {
              // Without a member the background refresh stops asking as a signed-out browser.
              setMe(null);
              setSignedOut(true);
            }}
            readOnly={readOnly}
          />
        ) : selected ? (
          <ChannelView
            key={selected.id}
            channel={selected}
            onChanged={onChanged}
            readOnly={readOnly}
          />
        ) : (
          <div className="settings">
            <div className="panel p-8">
              <h2>No channels yet</h2>
              <p className="muted">An admin can create a channel from Settings.</p>
              <button className="button primary" onClick={() => setSettings(true)}>
                Open settings
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
