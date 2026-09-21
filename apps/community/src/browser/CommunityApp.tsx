import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Menu, Plus, Settings2, X } from 'lucide-react';
import { Admission } from './components/Admission.js';
import { ChannelView } from './components/Channel.js';
import { Manage } from './components/Manage.js';
import { rememberCommunity } from './components/CommunityChooser.js';
import { describeError, RequestError, request } from './api.js';
import { takeInviteFragment } from './invite-fragment.js';
import type { Channel, Community, Me } from './types.js';

const initialInvite = takeInviteFragment();

/** Render the signed-in community shell or the admission path. */
export function CommunityApp() {
  const [inviteToken, setInviteToken] = useState(initialInvite);
  const [community, setCommunity] = useState<Community | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [unadmitted, setUnadmitted] = useState(false);
  const [hostSignIn, setHostSignIn] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const selected = useMemo(
    () => channels.find((channel) => channel.id === selectedId) ?? null,
    [channels, selectedId]
  );
  const returnToChooser = useCallback(() => {
    if (/^\/c\/[^/]+(?:\/|$)/u.test(window.location.pathname)) window.location.replace('/');
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
        (cause.status === 401 || cause.status === 403 || cause.code === 'COMMUNITY_UNAVAILABLE')
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
  useEffect(() => {
    if (!me) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshChannels();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [me?.member.memberId, refreshChannels]);
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
        if (inviteToken && /\/join$/u.test(window.location.pathname)) {
          setMe(null);
          setUnadmitted(false);
          return;
        }
        try {
          if (!inviteToken && /\/join$/u.test(window.location.pathname)) {
            try {
              await request('/api/v1/invites/bind', 'POST', {});
              await request('/api/v1/invites/redeem', 'POST', {});
            } catch (cause) {
              if (
                !(cause instanceof RequestError) ||
                (cause.status !== 401 && cause.status !== 403)
              )
                throw cause;
            }
          }
          const current = await request<Me>('/api/v1/me');
          if (!active) return;
          setMe(current);
          setUnadmitted(false);
          await refreshChannels();
        } catch (cause) {
          if (!active) return;
          if (cause instanceof RequestError && (cause.status === 401 || cause.status === 403)) {
            if (cause.status === 403 && /\/join$/u.test(window.location.pathname)) {
              try {
                await request('/api/v1/invites/bind', 'POST', {});
                await request('/api/v1/invites/redeem', 'POST', {});
                setInviteToken(null);
                setMe(await request<Me>('/api/v1/me'));
                await refreshChannels();
              } catch {
                setMe(null);
              }
            } else {
              if (cause.status === 403 && !inviteToken) returnToChooser();
              setMe(null);
              setUnadmitted(cause.status === 403);
            }
          } else if (cause instanceof RequestError && cause.code === 'COMMUNITY_UNAVAILABLE') {
            returnToChooser();
            setMe(null);
          } else setError(describeError(cause));
        }
      } catch (cause) {
        if (!active) return;
        if (cause instanceof RequestError && cause.status === 404) {
          setCommunity(null);
          setMe(null);
        } else if (cause instanceof RequestError && cause.code === 'COMMUNITY_SELECTION_REQUIRED') {
          setHostSignIn(true);
          setMe(null);
        } else if (cause instanceof RequestError && cause.code === 'COMMUNITY_UNAVAILABLE') {
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
  }, [revision, refreshChannels, returnToChooser, inviteToken]);
  const onChanged = useCallback(() => {
    void refreshChannels();
  }, [refreshChannels]);
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
  if (!me)
    return (
      <Admission
        community={community}
        hostSignIn={hostSignIn}
        inviteToken={inviteToken}
        unadmitted={unadmitted}
        onAdmitted={() => {
          if (hostSignIn) {
            window.location.assign('/');
            return;
          }
          setInviteToken(null);
          setRevision((old) => old + 1);
        }}
      />
    );
  const choose = (id: string) => {
    setSelectedId(id);
    setSettings(false);
    setMobileOpen(false);
  };
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
          {channels.some((channel) => !channel.joined) && (
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
                {settings
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
            <button className="button" onClick={() => setSettings(false)}>
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
            selectedChannel={selected}
            onChanged={onChanged}
            onCurrentMemberChanged={refreshCurrentMember}
            onLeft={() => {
              window.location.assign('/');
            }}
          />
        ) : selected ? (
          <ChannelView key={selected.id} channel={selected} onChanged={onChanged} />
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
