import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, KeyRound, Plus, Shield, Trash2, UserPlus } from 'lucide-react';
import { describeError, download, request } from '../api.js';
import type { Agent, Channel, Member } from '../types.js';

type Invite = {
  id: string;
  channelId: string | null;
  createdAt: string;
  expiresAt: string;
  seats: number;
  uses: number;
  revoked: boolean;
};
type Grant = {
  id: string;
  memberId: string;
  installName: string;
  scopes: string[];
  createdAt: string;
};
type Props = {
  me: Member;
  channels: Channel[];
  selectedChannel: Channel | null;
  onChanged: () => void;
  onCurrentMemberChanged: () => Promise<Member>;
  onLeft: () => void;
};
/** Manage channel, member, agent and account actions for the current role. */
export function Manage({
  me,
  channels,
  selectedChannel,
  onChanged,
  onCurrentMemberChanged,
  onLeft,
}: Props) {
  const moderator = me.role === 'owner' || me.role === 'admin';
  const [tab, setTab] = useState<'community' | 'members' | 'agents' | 'account'>('community');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteChannel, setInviteChannel] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [directory, setDirectory] = useState<Member[]>([]);
  const [directoryCursor, setDirectoryCursor] = useState<string | null>(null);
  const [roster, setRoster] = useState<Member[]>([]);
  const [selectedMember, setSelectedMember] = useState('');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [successor, setSuccessor] = useState('');
  const [password, setPassword] = useState('');
  const refresh = useCallback(
    async (currentModerator = moderator) => {
      try {
        const requests: Promise<unknown>[] = [
          request<{ grants: Grant[] }>('/api/v1/me/grants').then((body) => setGrants(body.grants)),
          request<{ agents: Agent[] }>('/api/v1/agents').then((body) => setAgents(body.agents)),
        ];
        if (currentModerator) {
          requests.push(
            request<{ invites: Invite[] }>('/api/v1/invites').then((body) =>
              setInvites(body.invites)
            )
          );
          requests.push(
            request<{ members: Member[]; nextCursor: string | null }>(
              '/api/v1/members?limit=50'
            ).then((body) => {
              setDirectory(body.members);
              setDirectoryCursor(body.nextCursor);
            })
          );
        }
        if (selectedChannel?.joined)
          requests.push(
            request<{ members: Member[] }>(`/api/v1/channels/${selectedChannel!.id}/members`).then(
              (body) => setRoster(body.members)
            )
          );
        await Promise.all(requests);
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [moderator, selectedChannel?.id, selectedChannel?.joined]
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function perform(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      setMessage(success);
      // Roles can change without a navigation, most visibly when ownership is
      // transferred. Refresh the shell's identity before fetching panels so
      // the old owner immediately sees the member controls they may use.
      const current = await onCurrentMemberChanged();
      await refresh(current.role === 'owner' || current.role === 'admin');
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function createChannel(event: React.FormEvent) {
    event.preventDefault();
    await perform(
      () => request('/api/v1/channels', 'POST', { name: channelName, description, visibility }),
      'Channel created.'
    );
    setChannelName('');
    setDescription('');
  }
  async function createInvite() {
    setBusy(true);
    setError('');
    try {
      const body = await request<{ token: string }>('/api/v1/invites', 'POST', {
        ...(inviteChannel ? { channelId: inviteChannel } : {}),
      });
      const link = `${location.origin}${location.pathname}#invite=${encodeURIComponent(body.token)}`;
      setInviteLink(link);
      setMessage('Copy this link now. It will not appear in the invite list.');
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function moreMembers() {
    if (!directoryCursor) return;
    try {
      const body = await request<{ members: Member[]; nextCursor: string | null }>(
        `/api/v1/members?limit=50&cursor=${directoryCursor}`
      );
      setDirectory((old) => [...old, ...body.members]);
      setDirectoryCursor(body.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
    }
  }
  async function exportArchive(owner: boolean) {
    await perform(async () => {
      const body = await request<{ archiveId: string }>(
        owner ? '/api/v1/owner/export' : '/api/v1/me/export',
        'POST',
        owner ? { password } : {}
      );
      await download(
        `/api/v1/exports/${body.archiveId}`,
        owner ? 'community-export.zip' : 'my-community-data.zip'
      );
    }, 'Your export is ready.');
  }
  async function leave() {
    if (
      !window.confirm(
        'Leave this community? You will lose access to channels and your local connections.'
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await request('/api/v1/me/leave', 'POST', {});
      onLeft();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="content-scroll">
      <main className="settings">
        <p className="eyebrow">Community settings</p>
        <h2>Make room for your people.</h2>
        <p className="muted">Manage channels and access without leaving the conversation.</p>
        <nav className="row mb-6" aria-label="Settings sections">
          {(['community', 'members', 'agents', 'account'] as const).map((item) => (
            <button
              key={item}
              className={`button ${tab === item ? 'primary' : ''}`}
              onClick={() => {
                setTab(item);
                setError('');
                setMessage('');
                void refresh();
              }}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>
        {error && (
          <div className="notice error mb-4" role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className="notice success mb-4" role="status">
            {message}
          </div>
        )}
        {tab === 'community' && (
          <div className="settings-grid">
            {moderator && (
              <>
                <section className="panel">
                  <h3>Create channel</h3>
                  <form onSubmit={(event) => void createChannel(event)}>
                    <div className="field">
                      <label htmlFor="channel-new-name">Name</label>
                      <input
                        id="channel-new-name"
                        value={channelName}
                        onChange={(event) => setChannelName(event.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="channel-description">Description</label>
                      <input
                        id="channel-description"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="channel-visibility">Visibility</label>
                      <select
                        id="channel-visibility"
                        value={visibility}
                        onChange={(event) =>
                          setVisibility(event.target.value as 'public' | 'private')
                        }
                      >
                        <option value="public">Public to members</option>
                        <option value="private">Only invited members</option>
                      </select>
                    </div>
                    <button className="button primary" disabled={busy}>
                      <Plus size={16} /> Create channel
                    </button>
                  </form>
                </section>
                <section className="panel">
                  <h3>Invite someone</h3>
                  <p className="small muted">
                    New links last seven days and admit one person unless changed by an admin.
                  </p>
                  <div className="field">
                    <label htmlFor="invite-channel">Channel</label>
                    <select
                      id="invite-channel"
                      value={inviteChannel}
                      onChange={(event) => setInviteChannel(event.target.value)}
                    >
                      <option value="">Community access</option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          #{channel.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void createInvite()}
                  >
                    <UserPlus size={16} /> Create invite
                  </button>
                  {inviteLink && (
                    <div className="field mt-4">
                      <label htmlFor="invite-link">One-time invite link</label>
                      <input
                        id="invite-link"
                        readOnly
                        value={inviteLink}
                        onFocus={(event) => event.target.select()}
                      />
                      <button
                        className="button"
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(inviteLink)}
                      >
                        <Copy size={15} /> Copy link
                      </button>
                    </div>
                  )}
                  {invites.length > 0 && (
                    <>
                      <hr className="divider" />
                      <h4 className="small font-semibold">Recent invites</h4>
                      {invites.map((invite) => (
                        <div className="row small mt-2 justify-between" key={invite.id}>
                          <span>
                            {invite.revoked ? 'Revoked' : `${invite.uses}/${invite.seats} used`} ·{' '}
                            {new Date(invite.expiresAt).toLocaleDateString()}
                          </span>
                          {!invite.revoked && (
                            <button
                              className="button ghost"
                              aria-label="Revoke invite"
                              onClick={() =>
                                void perform(
                                  () => request(`/api/v1/invites/${invite.id}`, 'DELETE'),
                                  'Invite revoked.'
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </section>
              </>
            )}
            {selectedChannel && (
              <section className="panel">
                <h3>#{selectedChannel.name}</h3>
                <p className="small muted">
                  {selectedChannel.visibility} · {selectedChannel.archived ? 'Archived' : 'Active'}
                </p>
                {moderator && (
                  <div className="row">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => {
                        const name = window.prompt('Channel name', selectedChannel.name);
                        if (name)
                          void perform(
                            () =>
                              request(`/api/v1/channels/${selectedChannel!.id}`, 'PATCH', { name }),
                            'Channel renamed.'
                          );
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () =>
                            request(`/api/v1/channels/${selectedChannel!.id}`, 'PATCH', {
                              archived: !selectedChannel.archived,
                            }),
                          selectedChannel.archived ? 'Channel reopened.' : 'Channel archived.'
                        )
                      }
                    >
                      {selectedChannel.archived ? 'Reopen' : 'Archive'}
                    </button>
                  </div>
                )}
                {selectedChannel.joined && me.role !== 'owner' && (
                  <button
                    className="button mt-3"
                    disabled={busy}
                    onClick={() =>
                      void perform(
                        () => request(`/api/v1/channels/${selectedChannel!.id}/leave`, 'POST', {}),
                        'You left this channel.'
                      )
                    }
                  >
                    Leave channel
                  </button>
                )}
              </section>
            )}
          </div>
        )}
        {tab === 'members' && (
          <div className="settings-grid">
            <section className="panel">
              <h3>Channel roster {selectedChannel ? `· #${selectedChannel.name}` : ''}</h3>
              {!selectedChannel ? (
                <p className="muted">Choose a channel first.</p>
              ) : roster.length === 0 ? (
                <p className="muted">No members in this channel yet.</p>
              ) : (
                roster.map((member) => (
                  <div
                    className="row justify-between border-b border-[var(--line)] py-2"
                    key={member.memberId}
                  >
                    <div>
                      <strong>{member.displayName}</strong>{' '}
                      <span className="small muted">
                        @{member.handle} · {member.kind === 'agent' ? 'agent' : member.role}
                      </span>
                    </div>
                    {moderator && member.memberId !== me.memberId && (
                      <button
                        className="button ghost"
                        disabled={busy}
                        onClick={() =>
                          void perform(
                            () =>
                              member.kind === 'agent'
                                ? request(
                                    `/api/v1/channels/${selectedChannel!.id}/agents/${member.memberId}`,
                                    'DELETE'
                                  )
                                : request(
                                    `/api/v1/channels/${selectedChannel!.id}/members/${member.memberId}`,
                                    'DELETE'
                                  ),
                            member.kind === 'agent'
                              ? 'Agent removed from channel.'
                              : 'Member removed from channel.'
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))
              )}
              {moderator && (
                <div className="mt-4">
                  <div className="field">
                    <label htmlFor="add-member">Add member</label>
                    <select
                      id="add-member"
                      value={selectedMember}
                      onChange={(event) => setSelectedMember(event.target.value)}
                    >
                      <option value="">Choose a member</option>
                      {directory
                        .filter(
                          (member) => !roster.some((joined) => joined.memberId === member.memberId)
                        )
                        .map((member) => (
                          <option key={member.memberId} value={member.memberId}>
                            {member.displayName} (@{member.handle})
                          </option>
                        ))}
                    </select>
                  </div>
                  <button
                    className="button"
                    disabled={!selectedMember || busy}
                    onClick={() =>
                      void perform(
                        () =>
                          request(`/api/v1/channels/${selectedChannel!.id}/members`, 'POST', {
                            memberId: selectedMember,
                          }),
                        'Member added to channel.'
                      )
                    }
                  >
                    Add to channel
                  </button>
                </div>
              )}
            </section>
            {moderator && (
              <section className="panel">
                <h3>Community members</h3>
                {directory.map((member) => (
                  <div
                    className="row justify-between border-b border-[var(--line)] py-2"
                    key={member.memberId}
                  >
                    <div>
                      <strong>{member.displayName}</strong>
                      <div className="small muted">
                        @{member.handle} · {member.role}
                      </div>
                    </div>
                    <div className="row">
                      {me.role === 'owner' && member.memberId !== me.memberId && (
                        <button
                          className="button ghost"
                          aria-label={`${member.role === 'admin' ? 'Remove admin from' : 'Make'} ${member.displayName}${member.role === 'admin' ? '' : ' admin'}`}
                          disabled={busy}
                          onClick={() =>
                            void perform(
                              () =>
                                request(`/api/v1/members/${member.memberId}/role`, 'PATCH', {
                                  role: member.role === 'admin' ? 'member' : 'admin',
                                }),
                              member.role === 'admin' ? 'Admin removed.' : 'Admin granted.'
                            )
                          }
                        >
                          {member.role === 'admin' ? 'Make member' : 'Make admin'}
                        </button>
                      )}
                      {member.memberId !== me.memberId && member.role === 'member' && (
                        <button
                          className="button ghost"
                          disabled={busy}
                          aria-label={`Remove ${member.displayName} from community`}
                          onClick={() => {
                            if (window.confirm(`Remove ${member.displayName} from this community?`))
                              void perform(
                                () => request(`/api/v1/members/${member.memberId}`, 'DELETE'),
                                'Member removed.'
                              );
                          }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {directoryCursor && (
                  <button className="button mt-3" onClick={() => void moreMembers()}>
                    Show more members
                  </button>
                )}
              </section>
            )}
          </div>
        )}
        {tab === 'agents' && (
          <div className="settings-grid">
            <section className="panel">
              <h3>Your agents</h3>
              <p className="small muted">
                Add agents from a connected local install. Their credentials stay there.
              </p>
              {agents.length === 0 ? (
                <p className="muted">No agents connected yet.</p>
              ) : (
                agents.map((agent) => (
                  <div
                    className="row justify-between border-b border-[var(--line)] py-2"
                    key={agent.memberId}
                  >
                    <div>
                      <strong>{agent.displayName}</strong>
                      <div className="small muted">@{agent.handle} · owned by you</div>
                    </div>
                    <button
                      className="button ghost"
                      aria-label={`Remove ${agent.displayName}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${agent.displayName}?`))
                          void perform(
                            () => request(`/api/v1/agents/${agent.memberId}`, 'DELETE'),
                            'Agent removed.'
                          );
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
              {selectedChannel && agents.length > 0 && (
                <>
                  <hr className="divider" />
                  <div className="field">
                    <label htmlFor="add-agent">Add your agent to #{selectedChannel.name}</label>
                    <select
                      id="add-agent"
                      value={selectedAgent}
                      onChange={(event) => setSelectedAgent(event.target.value)}
                    >
                      <option value="">Choose an agent</option>
                      {agents
                        .filter(
                          (agent) => !roster.some((member) => member.memberId === agent.memberId)
                        )
                        .map((agent) => (
                          <option key={agent.memberId} value={agent.memberId}>
                            {agent.displayName}
                          </option>
                        ))}
                    </select>
                  </div>
                  <button
                    className="button"
                    disabled={!selectedAgent || busy}
                    onClick={() =>
                      void perform(
                        () =>
                          request(`/api/v1/channels/${selectedChannel!.id}/agents`, 'POST', {
                            agentId: selectedAgent,
                          }),
                        'Agent added to channel.'
                      )
                    }
                  >
                    Add agent
                  </button>
                </>
              )}
            </section>
            <section className="panel">
              <h3>Agents in this channel</h3>
              {roster.filter((member) => member.kind === 'agent').length === 0 ? (
                <p className="muted">No agents here yet.</p>
              ) : (
                roster
                  .filter((member) => member.kind === 'agent')
                  .map((agent) => (
                    <div
                      key={agent.memberId}
                      className="row justify-between border-b border-[var(--line)] py-2"
                    >
                      <div>
                        <strong>{agent.displayName}</strong>
                        <div className="small muted">
                          Owned by{' '}
                          {agent.ownerDisplayName ??
                            directory.find((person) => person.memberId === agent.ownerMemberId)
                              ?.displayName ??
                            (agent.ownerMemberId === me.memberId ? 'you' : 'another member')}
                        </div>
                      </div>
                      {selectedChannel && (moderator || agent.ownerMemberId === me.memberId) && (
                        <button
                          className="button ghost"
                          onClick={() =>
                            void perform(
                              () =>
                                request(
                                  `/api/v1/channels/${selectedChannel!.id}/agents/${agent.memberId}`,
                                  'DELETE'
                                ),
                              'Agent removed from channel.'
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))
              )}
            </section>
          </div>
        )}
        {tab === 'account' && (
          <div className="settings-grid">
            <section className="panel">
              <h3>Local connections</h3>
              <p className="small muted">See and remove each install that can act for you.</p>
              {grants.length === 0 ? (
                <p className="muted">No local installs connected.</p>
              ) : (
                grants.map((grant) => (
                  <div
                    key={grant.id}
                    className="row justify-between border-b border-[var(--line)] py-2"
                  >
                    <div>
                      <strong>{grant.installName}</strong>
                      <div className="small muted">
                        {grant.scopes.join(', ')} · {new Date(grant.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      className="button ghost"
                      aria-label={`Remove ${grant.installName} connection`}
                      onClick={() =>
                        void perform(
                          () => request(`/api/v1/me/grants/${grant.id}`, 'DELETE'),
                          'Connection removed.'
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
            </section>
            <section className="panel">
              <h3>Your data</h3>
              <p className="small muted">
                Download a copy of your account, posts, agent activity, and files.
              </p>
              <button className="button" disabled={busy} onClick={() => void exportArchive(false)}>
                <Download size={16} /> Export my data
              </button>
              {me.role === 'owner' && (
                <>
                  <hr className="divider" />
                  <h3>Community export</h3>
                  <p className="small muted">
                    Includes the whole community. Confirm your password.
                  </p>
                  <div className="field">
                    <label htmlFor="export-password">Password</label>
                    <input
                      id="export-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <button
                    className="button"
                    disabled={!password || busy}
                    onClick={() => void exportArchive(true)}
                  >
                    <Shield size={16} /> Export community
                  </button>
                </>
              )}
            </section>
            <section className="panel">
              <h3>Leave community</h3>
              {me.role === 'owner' ? (
                <p className="small muted">Transfer ownership before you leave.</p>
              ) : (
                <>
                  <p className="small muted">
                    You will lose channel access and local connections. Your past messages stay
                    attributed to you.
                  </p>
                  <button className="button danger" disabled={busy} onClick={() => void leave()}>
                    Leave community
                  </button>
                </>
              )}
              {me.role === 'owner' && (
                <>
                  <div className="field">
                    <label htmlFor="successor">New owner</label>
                    <select
                      id="successor"
                      value={successor}
                      onChange={(event) => setSuccessor(event.target.value)}
                    >
                      <option value="">Choose a member</option>
                      {directory
                        .filter((member) => member.memberId !== me.memberId)
                        .map((member) => (
                          <option key={member.memberId} value={member.memberId}>
                            {member.displayName}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="transfer-password">Confirm password</label>
                    <input
                      id="transfer-password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <button
                    className="button danger"
                    disabled={!successor || !password || busy}
                    onClick={() =>
                      void perform(
                        () =>
                          request<{ lifecycleVersion: number }>('/api/v1/settings').then(
                            (settings) =>
                              request('/api/v1/owner/transfer', 'POST', {
                                successorMemberId: successor,
                                password,
                                lifecycleVersion: settings.lifecycleVersion,
                              })
                          ),
                        'Ownership transferred.'
                      )
                    }
                  >
                    <KeyRound size={16} /> Transfer ownership
                  </button>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
