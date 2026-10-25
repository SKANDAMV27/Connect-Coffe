import React, { useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { AlertCircle, Search } from 'lucide-react';

import { getOfferContacts } from '../api';
import { channelLabel, getDeliveryStatus } from '../lib/deliveryStatus';
import { WINDOW_MS, isInWindow } from '../lib/replyWindow';

import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Tabs } from './ui/tabs';

const PAGE_SIZE = 25;

const sentRecently = (c) => c.last_offer_at && c.last_status !== 'skipped' && Date.now() - new Date(c.last_offer_at) < WINDOW_MS;
const neverSent = (c) => !c.last_offer_at || (c.last_status === 'skipped' && c.offers_sent === 0);
const reached = (c) => c.last_status === 'delivered' || c.last_status === 'read';

/** Each filter: its label and which contacts it keeps. Opted-out ones are only under All. */
const FILTERS = [
  { value: 'all', label: 'All', keep: () => true },
  { value: 'never', label: 'Not sent yet', keep: (c) => !c.opt_out && neverSent(c) },
  { value: 'recent', label: 'Sent in last 24h', keep: (c) => sentRecently(c) },
  { value: 'reached', label: 'Got it', keep: (c) => reached(c) },
  { value: 'failed', label: 'Failed', keep: (c) => c.last_status === 'failed' },
  { value: 'held', label: 'Held back', keep: (c) => c.last_status === 'skipped' },
];

/**
 * Every contact against the offers they were sent: when the last one went,
 * whether it arrived, and who has not had one yet — so the next offer can be
 * aimed and nobody gets two by accident.
 */
export default function OfferContacts({ refreshKey }) {
  const [state, setState] = useState({ loading: true, error: '', list: [] });
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    let live = true;
    getOfferContacts()
      .then(({ data }) => live && setState({ loading: false, error: '', list: data.data || [] }))
      .catch((err) => {
        console.error(err);
        if (live) setState((s) => ({ ...s, loading: false, error: 'Could not load the contacts. Refresh to try again.' }));
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.value, state.list.filter(f.keep).length])),
    [state.list],
  );

  const shown = useMemo(() => {
    const keep = FILTERS.find((f) => f.value === filter).keep;
    const q = query.trim().toLowerCase();
    return state.list.filter(
      (c) => keep(c) && (!q || c.phone.includes(q) || (c.name || '').toLowerCase().includes(q)),
    );
  }, [state.list, filter, query]);

  const lastPage = Math.max(0, Math.ceil(shown.length / PAGE_SIZE) - 1);
  const rows = shown.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Contacts and offers</p>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-text-secondary">
            When each contact last got an offer and whether it arrived. “Not sent yet” is who the next offer should
            reach; “Sent in last 24h” is who already has one.
          </p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-titanium-700" />
          <Input
            aria-label="Search contacts"
            placeholder="Name or number"
            className="pl-9"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </div>
      </div>

      <div className="mb-3 overflow-x-auto">
        <Tabs
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
          layoutId="offer-contacts-filter"
          items={FILTERS.map((f) => ({ value: f.value, label: `${f.label} · ${counts[f.value] ?? 0}` }))}
        />
      </div>

      {state.error && (
        <p role="alert" className="mb-3 flex items-center gap-2 text-[13px] text-danger">
          <AlertCircle className="size-4" /> {state.error}
        </p>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-paper text-left text-[11px] uppercase tracking-[0.08em] text-text-secondary">
              <tr>
                <th className="px-5 py-3 font-medium">Contact</th>
                <th className="px-5 py-3 font-medium">Last offer</th>
                <th className="px-5 py-3 font-medium">Result</th>
                <th className="hidden px-5 py-3 font-medium md:table-cell">Free window</th>
                <th className="hidden px-5 py-3 text-right font-medium md:table-cell">Offers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => {
                const status = c.opt_out
                  ? { label: 'Unsubscribed', badge: 'outline' }
                  : neverSent(c)
                    ? { label: c.last_status === 'skipped' ? 'Held back' : 'Not sent yet', badge: c.last_status === 'skipped' ? 'warning' : 'outline' }
                    : getDeliveryStatus(c.last_status);
                const sentAt = c.last_offer_at && c.last_status !== 'skipped' ? parseISO(c.last_offer_at) : null;
                return (
                  <tr key={c.phone}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink">{c.name || 'No name'}</p>
                      <p className="tabular-nums text-text-secondary">+{c.phone}</p>
                    </td>
                    <td className="px-5 py-3">
                      {sentAt ? (
                        <>
                          <p className={sentRecently(c) ? 'font-medium text-ink' : 'text-body-text'}>
                            {formatDistanceToNowStrict(sentAt, { addSuffix: true })}
                          </p>
                          <p className="text-[12px] text-text-secondary">
                            {format(sentAt, "d MMM, h:mm a")}
                            {c.last_campaign ? ` · offer #${c.last_campaign}` : ''}
                          </p>
                        </>
                      ) : (
                        <span className="text-text-secondary">Never</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={status.badge}>{status.label}</Badge>
                        {sentAt && <span className="text-[11px] text-text-secondary">{channelLabel(c.last_channel)}</span>}
                      </div>
                      {c.last_status === 'failed' && c.last_error && (
                        <p className="mt-1 max-w-[36ch] text-[12px] leading-snug text-text-secondary">{c.last_error}</p>
                      )}
                    </td>
                    <td className="hidden px-5 py-3 md:table-cell">
                      {isInWindow(c.last_incoming_at) ? (
                        <span className="text-success">Open — free to send</span>
                      ) : (
                        <span className="text-text-secondary">Closed — paid only</span>
                      )}
                    </td>
                    <td className="hidden px-5 py-3 text-right tabular-nums text-text-secondary md:table-cell">
                      {c.offers_sent}
                    </td>
                  </tr>
                );
              })}
              {!state.loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-text-secondary">
                    No contacts here.
                  </td>
                </tr>
              )}
              {state.loading && (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center">
                    <span className="mx-auto block size-6 animate-spin rounded-full border-2 border-line border-t-ink" />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {shown.length > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-4 border-t border-border bg-paper px-5 py-3.5">
            <p className="text-[13px] text-text-secondary">
              {page * PAGE_SIZE + 1}–{Math.min(shown.length, (page + 1) * PAGE_SIZE)} of{' '}
              <span className="tabular-nums">{shown.length}</span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((v) => v - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={page >= lastPage} onClick={() => setPage((v) => v + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
