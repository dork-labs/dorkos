import { Button } from '@dork-labs/ui';
import { useCallback, useEffect, useState } from 'react';
import type {
  CommunityWireReport,
  CommunityWireReportResolveRequest as Resolution,
} from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import { BanDialog } from '../components/members/BanDialogs.js';
import { MuteDialog } from './MuteDialog.js';
import type { Perform } from '../components/members/SpaceMembers.js';

/** Who a mute or ban from a report lands on: an agent's owner, never the agent. */
function subjectOf(report: CommunityWireReport): string {
  return report.author.kind === 'agent'
    ? `the owner of ${report.author.displayName}`
    : report.author.displayName;
}

/** What each report reason says on screen. */
export const REPORT_REASON_LABELS: Record<CommunityWireReport['reason'], string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  off_topic: 'Off topic',
  illegal: 'Illegal content',
  other: 'Other',
};

const ACTION_LABELS: Record<NonNullable<CommunityWireReport['action']>, string> = {
  remove: 'Message removed',
  mute: 'Author muted',
  ban: 'Author banned',
};

/**
 * The report queue, for owners and admins: open reports oldest first, each resolved by removing
 * the message, muting or banning its author (an agent's owner), or dismissing it. Resolving one
 * resolves every open report of the same message. Resolved reports can be shown instead.
 */
export function ReportQueue({ busy, perform }: { busy: boolean; perform: Perform }) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [reports, setReports] = useState<CommunityWireReport[]>([]);
  const [error, setError] = useState('');
  const [muting, setMuting] = useState<CommunityWireReport | null>(null);
  const [banning, setBanning] = useState<CommunityWireReport | null>(null);
  const reload = useCallback(async () => {
    try {
      const body = await request<{ reports: CommunityWireReport[] }>(
        `/api/v1/reports?status=${status}`
      );
      setReports(body.reports);
      setError('');
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [status]);
  useEffect(() => {
    void reload();
  }, [reload]);
  function resolve(report: CommunityWireReport, resolution: Resolution, success: string) {
    void perform(
      () => request(`/api/v1/reports/${report.id}/resolve`, 'POST', resolution),
      success
    ).then(reload);
  }
  return (
    <section className="panel" aria-labelledby="report-queue-title">
      <div className="row justify-between">
        <h3 id="report-queue-title">Flagged messages</h3>
        <Button variant="ghost" onClick={() => setStatus(status === 'open' ? 'resolved' : 'open')}>
          {status === 'open' ? 'Show resolved' : 'Show open'}
        </Button>
      </div>
      {error && (
        <p className="small muted" role="alert">
          {error}
        </p>
      )}
      {!error && reports.length === 0 && (
        <p className="small muted">
          {status === 'open' ? 'Nothing flagged.' : 'Nothing resolved yet.'}
        </p>
      )}
      {reports.map((report) => (
        <article className="border-b border-[var(--line)] py-2" key={report.id}>
          <div className="small muted">
            {REPORT_REASON_LABELS[report.reason]} · From{' '}
            {report.reporter?.displayName ?? report.checkName ?? 'a former member'}
            {report.action ? ` · ${ACTION_LABELS[report.action]}` : ''}
            {report.status === 'dismissed' ? ' · Dismissed' : ''}
          </div>
          <p className="mb-1">
            <strong>{report.author.displayName}</strong>
            {report.author.kind === 'agent' ? ' (agent)' : ''}:{' '}
            {report.excerpt ?? <span className="muted">In a channel you haven't joined.</span>}
          </p>
          {report.note && <p className="small mb-1">“{report.note}”</p>}
          {report.status === 'open' && (
            <div className="row">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => resolve(report, { action: 'remove' }, 'Message removed.')}
              >
                Remove message
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setMuting(report)}>
                Mute author
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setBanning(report)}>
                Ban author
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => resolve(report, { action: 'dismiss' }, 'Report dismissed.')}
              >
                Dismiss
              </Button>
            </div>
          )}
        </article>
      ))}
      {muting && (
        <MuteDialog
          name={subjectOf(muting)}
          busy={busy}
          onClose={() => setMuting(null)}
          onMute={(minutes) => {
            const report = muting;
            setMuting(null);
            resolve(report, { action: 'mute', minutes }, 'Author muted.');
          }}
        />
      )}
      {banning && (
        <BanDialog
          name={subjectOf(banning)}
          busy={busy}
          onClose={() => setBanning(null)}
          onBan={(reason) => {
            const report = banning;
            setBanning(null);
            resolve(report, { action: 'ban', ...(reason ? { reason } : {}) }, 'Author banned.');
          }}
        />
      )}
    </section>
  );
}
