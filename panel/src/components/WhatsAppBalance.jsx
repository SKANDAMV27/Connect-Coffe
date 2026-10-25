import React, { useState } from 'react';
import { format, parseISO } from 'date-fns';

import { setMetaBalance } from '../api';
import { rupees } from '../lib/money';

import { Button } from './ui/button';
import { Input } from './ui/input';

const Spend = ({ label, value }) => (
  <div>
    <p className="font-heading text-lg font-bold tabular-nums text-ink">{rupees(value)}</p>
    <p className="text-[12px] text-text-secondary">{label}</p>
  </div>
);

/**
 * The WhatsApp prepaid balance and what has been spent. Meta reports the
 * spend but will not tell this app the balance, so it is entered here as read
 * off WhatsApp Manager, and the spend since is taken off it.
 */
export default function WhatsAppBalance({ billing, onChange }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async (event) => {
    event.preventDefault();
    const n = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(n) || n < 0) {
      setError('Enter the balance in rupees, as WhatsApp Manager shows it.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { data } = await setMetaBalance(n);
      onChange?.(data);
      setEditing(false);
      setAmount('');
    } catch (err) {
      console.error(err);
      setError('Not saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const low = billing?.balance_estimate != null && billing.balance_estimate < 100;

  return (
    <div className="rounded-xl border border-border bg-white px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">WhatsApp balance</p>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-[12px] font-medium text-primary underline-offset-2 hover:underline"
          >
            {billing?.balance == null ? 'Enter balance' : 'Update balance'}
          </button>
        )}
      </div>

      {billing == null ? (
        <p className="mt-2 text-[13px] text-text-secondary">Spending could not be read just now.</p>
      ) : (
        <>
          {billing.balance_estimate != null ? (
            <>
              <p className={`mt-1 font-heading text-2xl font-bold tabular-nums ${low ? 'text-danger' : 'text-ink'}`}>
                {rupees(billing.balance_estimate)}
                <span className="ml-1.5 text-[13px] font-normal text-text-secondary">left, about</span>
              </p>
              <p className="text-[12px] leading-relaxed text-text-secondary">
                {rupees(billing.balance)} entered
                {billing.balance_at ? ` ${format(parseISO(billing.balance_at), "d MMM 'at' h:mm a")}` : ''}, less{' '}
                {rupees(billing.spent_since)} WhatsApp has charged since.
              </p>
            </>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
              WhatsApp does not share the balance with the panel. Enter it from WhatsApp Manager → Billing, and it
              counts down as offers are charged.
            </p>
          )}

          {editing && (
            <form onSubmit={save} className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-text-secondary">₹</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  aria-label="Balance in rupees"
                  placeholder="e.g. 999.99"
                  className="h-9 w-32"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoFocus
                />
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-[12px] text-text-secondary">
                Read it off business.facebook.com → WhatsApp Manager → Billing, then save. Update it after each
                top-up.
              </p>
              {error && (
                <p role="alert" className="text-[12px] text-danger">
                  {error}
                </p>
              )}
            </form>
          )}

          <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3">
            <Spend label={`today · ${billing.paid_today} paid`} value={billing.spent_today} />
            <Spend label="last 7 days" value={billing.spent_7d} />
            <Spend label="this month" value={billing.spent_month} />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {billing.problem ||
              `${rupees(billing.rate, 4)} per paid message delivered${
                billing.rate_from_meta ? ', as WhatsApp charged lately' : ''
              }. Free messages cost nothing. WhatsApp’s figures can run a little behind.`}
          </p>
        </>
      )}
    </div>
  );
}
