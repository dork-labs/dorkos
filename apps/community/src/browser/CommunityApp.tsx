import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Menu, Plus, Settings2, X } from 'lucide-react';
import { Admission } from './components/Admission.js';
import { ChannelView } from './components/Channel.js';
import { Manage } from './components/Manage.js';
import { describeError, RequestError, request } from './api.js';
import type { Channel, Community, Me } from './types.js';

function readInvite() {
  const token =
    new URLSearchParams(window.location.hash.slice(1)).get('invite') ??
    sessionStorage.getItem('communityPendingInvite');
  if (token)
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return token;
}
const initialInvite = readInvite();

/** Render the signed-in community shell or the admission path. */
export function CommunityApp() {
  const [inviteToken, setInviteToken] = useState(initialInvite);
  const [community, setCommunity] = useState<Community | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [unadmitted, setUnadmitted] = useState(false);
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
      if (cause instanceof RequestError && (cause.status === 401 || cause.status === 403))
        setMe(null);
      else setError(describeError(cause));
    }
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
        try {
          const current = await request<Me>('/api/v1/me');
          if (!active) return;
          setMe(current);
          setUnadmitted(false);
          await refreshChannels();
        } catch (cause) {
          if (!active) return;
          if (cause instanceof RequestError && (cause.status === 401 || cause.status === 403)) {
            if (cause.status === 403 && sessionStorage.getItem('communityPendingInvite')) {
              try {
                await request('/api/v1/invites/redeem', 'POST', {
                  token: sessionStorage.getItem('communityPendingInvite'),
                });
                sessionStorage.removeItem('communityPendingInvite');
                setInviteToken(null);
                setMe(await request<Me>('/api/v1/me'));
                await refreshChannels();
              } catch {
                setMe(null);
              }
            } else {
              setMe(null);
              setUnadmitted(cause.status === 403);
            }
          } else setError(describeError(cause));
        }
      } catch (cause) {
        if (!active) return;
        if (cause instanceof RequestError && cause.status === 404) {
          setCommunity(null);
          setMe(null);
        } else setError(describeError(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [revision, refreshChannels]);
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
        inviteToken={inviteToken}
        unadmitted={unadmitted}
        onAdmitted={() => {
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
            me={me.member}
            channels={channels}
            selectedChannel={selected}
            onChanged={onChanged}
            onLeft={() => {
              setError('');
              setMe(null);
              setRevision((old) => old + 1);
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
