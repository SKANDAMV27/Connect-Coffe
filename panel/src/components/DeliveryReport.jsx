import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { AlertCircle, RotateCcw, Search } from 'lucide-react';

import { getCampaignRecipients, retryCampaign } from '../api';
import { channelLabel, explainError, getDeliveryStatus } from '../lib/deliveryStatus';

import { Dialog, DialogHeader, DialogBody, DialogFooter } from './ui/dialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Tabs } from './ui/tabs';
import { rupees } from '../lib/money';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Held back' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'read', label: 'Read' },
];

const LIST_LIMIT = 200; // rows drawn at once; search narrows the rest

/** A figure with its label, in the report's top row. */
const Figure = ({ label, value, hint, tone }) => (
  <div className="rounded-xl border border-border bg-white px-4 py-3">
    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">{label}</p>
    <p
      className={`mt-1 font-heading text-2xl font-bold tabular-nums ${
        tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : 'text-ink'
      }`}
    >
      {value}
    </p>
    {hint && <p className="mt-0.5 text-[11px] leading-snug text-text-secondary">{hint}</p>}
  </div>
);

const percent = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');

/**
 * Who one offer reached, who it did not and why, and a way to send it again
 * to the ones it missed.
 */
export default function DeliveryReport({ campaign, onClose, onRetried }) {
  const [state, setState] = useState({ loading: true, error: '', list: [], retry: null, limit: null, rate: 0 });
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const confirmRef = useRef(null);

  // The confirmation sits under a long report; bring it into view.
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [confirming]);

  const load = useCallback(() => {
    if (!campaign) return;
    setState((s) => ({ ...s, loading: true, error: '' }));
    getCampaignRecipients(campaign.id)
      .then(({ data }) =>
        setState({ loading: false, error: '', list: data.data || [], retry: data.retry, limit: data.limit, rate: data.rate || 0 }),
      )
      .catch((err) => {
        console.error(err);
        setState((s) => ({ ...s, loading: false, error: 'Could not load the report. Try again.' }));
      });
  }, [campaign]);

  useEffect(() => {
    setFilter('all');
    setQuery('');
    setConfirming(false);
    setRetryError('');
    load();
  }, [load]);

  const { list, retry, limit, rate } = state;

  const counts = useMemo(() => {
    const c = { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, free: 0, paid: 0, paidDelivered: 0 };
    for (const r of list) {
      if (r.status === 'skipped') {
        c.skipped++;
        continue;
      }
      c.sent++;
      if (r.channel === 'template') c.paid++;
      else c.free++;
      if (r.status === 'delivered' || r.status === 'read') {
        c.delivered++;
        if (r.channel === 'template') c.paidDelivered++;
      }
      if (r.status === 'read') c.read++;
      if (r.status === 'failed') c.failed++;
    }
    return c;
  }, [list]);

  // Why it missed people, biggest reason first.
  const reasons = useMemo(() => {
    const by = new Map();
    for (const r of list) {
      if (r.status !== 'failed' && r.status !== 'skipped') continue;
      const key = r.status === 'skipped' ? `skipped:${r.error}` : `${r.error_code}:${r.error}`;
      const entry = by.get(key) || {
        key,
        count: 0,
        ...(r.status === 'skipped'
          ? { title: 'Held back by the daily limit', explain: r.error, retry: 'Retry sends to them, within the limit.' }
          : explainError(r.error_code, r.error)),
      };
      entry.count++;
      by.set(key, entry);
    }
    return [...by.values()].sort((a, b) => b.count - a.count);
  }, [list]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((r) => {
      if (filter === 'delivered' && r.status !== 'delivered' && r.status !== 'read') return false;
      if (filter !== 'all' && filter !== 'delivered' && r.status !== filter) return false;
      return !q || r.phone.includes(q) || (r.name || '').toLowerCase().includes(q);
    });
  }, [list, filter, query]);

  // What a retry would send now: the free ones all go; the paid ones only up
  // to what today's limit has left.
  const paidLeft = limit ? (limit.left < 0 ? Infinity : limit.left) : 0;
  const retryPaid = retry ? Math.min(retry.paid, paidLeft) : 0;
  const retryHeld = retry ? retry.paid - retryPaid : 0;
  const retryTotal = retry ? retry.free + retryPaid : 0;
  const ecosystemFailures = list.filter((r) => r.status === 'failed' && r.error_code === 131049).length;

  const doRetry = async () => {
    setRetrying(true);
    setRetryError('');
    try {
      await retryCampaign(campaign.id);
      setConfirming(false);
      onRetried?.();
      load();
    } catch (err) {
      console.error(err);
      setRetryError(
        typeof err.response?.data === 'string' ? err.response.data : 'The retry was not sent. Try again.',
      );
    } finally {
      setRetrying(false);
    }
  };

  const untracked = !state.loading && !state.error && list.length === 0;

  return (
    <Dialog open={!!campaign} onClose={onClose} size="xl" labelledBy="report-title">
      <DialogHeader
        id="report-title"
        eyebrow={campaign?.retry_of ? `Retry of offer #${campaign.retry_of}` : 'Delivery report'}
        title={campaign ? `Offer #${campaign.id}` : ''}
        description={
          campaign?.scheduled_at
            ? `Went out ${format(parseISO(campaign.scheduled_at), "d MMM yyyy 'at' h:mm a")}. Updates as WhatsApp reports back.`
            : ''
        }
        onClose={onClose}
      />

      <DialogBody className="space-y-6">
        {state.error && (
          <p role="alert" className="flex items-center gap-2 text-[13px] text-danger">
            <AlertCircle className="size-4" /> {state.error}{' '}
            <button type="button" onClick={load} className="underline underline-offset-2">
              Try again
            </button>
          </p>
        )}

        {state.loading && (
          <span className="mx-auto block size-6 animate-spin rounded-full border-2 border-line border-t-ink" />
        )}

        {untracked && (
          <div className="rounded-xl border border-border bg-paper px-4 py-4 text-[13px] leading-relaxed text-body-text">
            <p className="font-medium text-ink">No per-contact report for this offer.</p>
            <p className="mt-1">
              It went out before delivery was tracked. It was sent to {campaign?.total_sent ?? 0} contacts; who
              received it was not recorded. Offers sent from now on show who got them, who read them, who did not
              and why.
            </p>
          </div>
        )}

        {!state.loading && list.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Figure label="Sent" value={counts.sent} hint={`${counts.free} free · ${counts.paid} paid`} />
              <Figure
                label="Delivered"
                value={counts.delivered}
                tone="success"
                hint={`${percent(counts.delivered, counts.sent)} of sent`}
              />
              <Figure label="Read" value={counts.read} hint={`${percent(counts.read, counts.delivered)} of delivered`} />
              <Figure
                label="Failed"
                value={counts.failed}
                tone={counts.failed ? 'danger' : undefined}
                hint="Not charged"
              />
              <Figure label="Held back" value={counts.skipped} hint="Over the limit, not sent" />
            </div>

            {counts.paid > 0 && (
              <p className="text-[12px] leading-relaxed text-text-secondary">
                Paid: {counts.paid} template messages sent, {counts.paidDelivered} delivered
                {rate > 0 && (
                  <>
                    {' '}— about <span className="font-medium text-ink">{rupees(counts.paidDelivered * rate)}</span> charged
                    at {rupees(rate, 4)} each
                  </>
                )}
                . Meta charges only for the delivered ones; failed and held-back messages cost nothing.
              </p>
            )}

            {reasons.length > 0 && (
              <section className="space-y-2">
                <p className="eyebrow">Why some did not get it</p>
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {reasons.map((r) => (
                    <li key={r.key} className="flex items-start gap-4 px-4 py-3">
                      <span className="w-10 shrink-0 text-right font-heading text-lg font-bold tabular-nums text-ink">
                        {r.count}
                      </span>
                      <div className="min-w-0 text-[13px] leading-relaxed">
                        <p className="font-medium text-ink">{r.title}</p>
                        <p className="text-body-text">{r.explain}</p>
                        <p className="text-text-secondary">{r.retry}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Tabs value={filter} onValueChange={setFilter} items={FILTERS} layoutId="report-filter" />
                <div className="relative w-full sm:w-60">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-titanium-700" />
                  <Input
                    aria-label="Search by name or number"
                    placeholder="Name or number"
                    className="pl-9"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </div>

              <div className="max-h-[22rem] overflow-y-auto rounded-xl border border-border">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 bg-paper text-left text-[11px] uppercase tracking-[0.08em] text-text-secondary">
                    <tr>
                      <th className="px-4 py-2 font-medium">Contact</th>
                      <th className="px-4 py-2 font-medium">Result</th>
                      <th className="hidden px-4 py-2 font-medium sm:table-cell">Reason</th>
                      <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {shown.slice(0, LIST_LIMIT).map((r) => {
                      const status = getDeliveryStatus(r.status);
                      return (
                        <tr key={`${r.phone}-${r.sent_at}`}>
                          <td className="px-4 py-2.5">
                            <p className="font-medium text-ink">{r.name || 'No name'}</p>
                            <p className="tabular-nums text-text-secondary">+{r.phone}</p>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant={status.badge}>{status.label}</Badge>
                              <span className="text-[11px] text-text-secondary">{channelLabel(r.channel)}</span>
                            </div>
                          </td>
                          <td className="hidden px-4 py-2.5 text-text-secondary sm:table-cell">
                            {r.status === 'failed' ? explainError(r.error_code, r.error).title : r.status === 'skipped' ? r.error : ''}
                          </td>
                          <td className="hidden px-4 py-2.5 text-right tabular-nums text-text-secondary sm:table-cell">
                            {format(parseISO(r.updated_at), 'd MMM, h:mm a')}
                          </td>
                        </tr>
                      );
                    })}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-text-secondary">
                          Nobody here.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {shown.length > LIST_LIMIT && (
                <p className="text-[12px] text-text-secondary">
                  Showing {LIST_LIMIT} of {shown.length}. Search to find someone.
                </p>
              )}
            </section>
          </>
        )}

        {confirming && retry && (
          <div
            ref={confirmRef}
            className="space-y-2 rounded-xl border border-ink/20 bg-paper px-4 py-4 text-[13px] leading-relaxed"
          >
            <p className="font-medium text-ink">
              Send this offer again to {retryTotal} {retryTotal === 1 ? 'contact' : 'contacts'} now?
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-body-text">
              {retry.free > 0 && <li>{retry.free} free — they messaged in the last 24 hours.</li>}
              {retryPaid > 0 && (
                <li>
                  {retryPaid} as the paid “{campaign.template_name}” template — up to {rupees(retryPaid * rate)} if all
                  arrive.
                </li>
              )}
              {retryHeld > 0 && (
                <li>
                  {retryHeld} held back: today’s limit has {limit.left} left. Retry again after 24 hours for them.
                </li>
              )}
            </ul>
            {ecosystemFailures > 0 && (
              <p className="text-warning">
                {ecosystemFailures} of them were blocked by WhatsApp's per-person marketing limit. Retried this soon,
                most will be held back again — waiting a few days works better.
              </p>
            )}
            {retryError && (
              <p role="alert" className="text-danger">
                {retryError}
              </p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter className="justify-between">
        <p className="text-[12px] leading-relaxed text-text-secondary">
          {retry?.pending
            ? 'A retry of this offer is going out now.'
            : retry
              ? retryTotal > 0
                ? `${retryTotal} of the contacts it missed can be tried again now.`
                : 'Nobody it missed can be reached again right now.'
              : ''}
        </p>
        <div className="flex gap-3">
          {confirming ? (
            <>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
                Back
              </Button>
              <Button type="button" onClick={doRetry} disabled={retrying}>
                <RotateCcw />
                {retrying ? 'Sending…' : `Send to ${retryTotal}`}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              {campaign?.status === 'sent' && (
                <Button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!retry || retry.pending || retryTotal === 0}
                >
                  <RotateCcw />
                  Retry {retryTotal > 0 ? retryTotal : ''} missed
                </Button>
              )}
            </>
          )}
        </div>
      </DialogFooter>
    </Dialog>
  );
}
