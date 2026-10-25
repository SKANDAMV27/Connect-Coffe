import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  Megaphone,
  Plus,
  Send,
  FileBarChart,
  Trash2,
  X,
} from 'lucide-react';

import {
  getCampaigns,
  createCampaign,
  deleteCampaign,
  uploadImage,
  getContacts,
  getWhatsAppTemplates,
  getMessagingLimit,
  getBilling,
} from '../api';
import { BUTTON_ACTIONS, actionLabel, guessAction } from '../lib/buttonActions';
import { getBroadcastStatus } from '../lib/broadcastStatus';
import { isInWindow } from '../lib/replyWindow';

import PageHeader from '../components/PageHeader';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import WhatsAppPreview, { FormattingHint } from '../components/WhatsAppPreview';
import DeliveryReport from '../components/DeliveryReport';
import OfferContacts from '../components/OfferContacts';
import WhatsAppBalance from '../components/WhatsAppBalance';
import { rupees } from '../lib/money';
import { Reveal } from '../components/motion/Reveal';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Tabs } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogHeader, DialogBody, DialogFooter } from '../components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../components/ui/table';

const PAGE_SIZE = 10;

const MAX_BUTTONS = 3; // WhatsApp's limit for reply buttons
const BUTTON_TEXT_LIMIT = 20; // WhatsApp's limit, counted in characters
const charCount = (text) => [...text].length; // an emoji is one character

const photo = (id) => `https://images.unsplash.com/photo-${id}?w=1200&h=900&fit=crop`;

// Ready-made offers to start from. Everything stays editable after picking
// one; the photos are placeholders until the cafe's own are uploaded.
const TEMPLATES = [
  {
    id: 'morning',
    label: '☀️ Good morning',
    image: photo('1509042239860-f550ce710b93'),
    caption:
      '☀️ *Good morning!*\n\nBreakfast is ready at Connect — freshly brewed coffee and warm bites to start your day right. Come take a try! ☕\n\n🕐 Open from 8 AM',
    buttons: [
      { id: 'view_menu', title: '☕ See Menu' },
      { id: 'visit', title: '📍 Visit Us' },
    ],
  },
  {
    id: 'discount',
    label: '🎉 20% off today',
    image: photo('1495474472287-4d71bcdd2085'),
    caption:
      '🎉 *20% OFF — today only!*\n\nShow this message at the counter and get *20% off* your order. ☕\n\nValid today, 8 AM – 9 PM.',
    buttons: [
      { id: 'visit', title: '📍 Visit Us' },
      { id: 'view_menu', title: '☕ See Menu' },
    ],
  },
  {
    id: 'visit',
    label: '📍 Come visit',
    image: photo('1554118811-1e0d58224f24'),
    caption:
      '📍 *Come say hi!*\n\nFreshly roasted, hand-brewed speciality coffee in RR Nagar 5th Stage. Your table is waiting. ☕',
    buttons: [
      { id: 'visit', title: '📍 Get Directions' },
      { id: 'view_offers', title: '🎁 See Offers' },
    ],
  },
  {
    id: 'roast',
    label: '🫘 Fresh roast',
    image: photo('1447933601403-0c6688de566e'),
    caption:
      '🫘 *Fresh roast just landed!*\n\nOur latest beans are out of the roaster and ready to brew. Pick up a bag, or try it as a pour-over today.',
    buttons: [
      { id: 'view_menu', title: '☕ See Menu' },
      { id: 'visit', title: '📍 Visit Us' },
    ],
  },
  {
    id: 'workshop',
    label: '🎨 Workshop',
    image: photo('1497935586351-b67a49e012bf'),
    caption:
      '🎨 *Coffee painting workshop*\n\nPaint with coffee and sip while you create — ₹649 a seat. Limited seats this weekend!\n\nReply here to save yours.',
    buttons: [
      { id: 'view_offers', title: '🎁 See Offers' },
      { id: 'visit', title: '📍 Visit Us' },
    ],
  },
  {
    id: 'evening',
    label: '🌇 Evening cold brew',
    image: photo('1461023058943-07fcbe16d735'),
    caption:
      '🌇 *Evening slump?*\n\nA cold brew fixes that. Drop by before 9 PM — we are brewing till close. 🧊☕',
    buttons: [
      { id: 'view_menu', title: '☕ See Menu' },
      { id: 'visit', title: '📍 Visit Us' },
    ],
  },
  {
    id: 'weekend',
    label: '🥳 Weekend special',
    image: photo('1498804103079-a6351b050096'),
    caption:
      '🥳 *Weekend special*\n\nBring a friend this weekend — *buy one, get the second at 50% off* on all hot coffees.',
    buttons: [
      { id: 'view_offers', title: '🎁 See Offers' },
      { id: 'view_menu', title: '☕ See Menu' },
    ],
  },
];

const WHEN_TABS = [
  { value: 'now', label: 'Send now' },
  { value: 'later', label: 'Schedule' },
];

const AUDIENCE_TABS = [
  { value: 'free', label: 'Last 24 hours' },
  { value: 'everyone', label: 'Everyone' },
];

/** A WhatsApp template's key in the picker: name and language together. */
const waKey = (t) => `${t.name}|${t.language}`;

/** A WhatsApp template's quick-reply buttons, in order. */
const waButtons = (t) =>
  ((t.components || []).find((c) => c.type === 'BUTTONS')?.buttons || []).filter((b) => b.type === 'QUICK_REPLY');

/** The text of one part of a WhatsApp template, such as its BODY. */
const waText = (t, type) => t?.components?.find((c) => c.type === type)?.text || '';

const SOURCE_TABS = [
  { value: 'url', label: 'Link' },
  { value: 'local', label: 'Upload' },
];

const emptyOffer = () => ({
  image_url: '',
  caption: '',
  scheduled_at: '',
  buttons: [
    { id: 'view_offers', title: '🎁 See Offers' },
    { id: 'view_menu', title: '☕ See Menu' },
  ],
});

/** Everything wrong with an offer's buttons, or '' if they can be sent. */
const buttonProblem = (buttons) => {
  if (buttons.length === 0) return 'Keep at least one button so people can reply.';
  const titles = buttons.map((b) => b.title.trim());
  const problems = [];
  if (titles.some((t) => !t)) problems.push('Every button needs text.');
  if (titles.some((t) => charCount(t) > BUTTON_TEXT_LIMIT)) {
    problems.push(`Button text can be at most ${BUTTON_TEXT_LIMIT} characters.`);
  }
  const filled = titles.filter(Boolean);
  if (new Set(filled).size !== filled.length) problems.push('Two buttons cannot have the same text.');
  if (new Set(buttons.map((b) => b.id)).size !== buttons.length) {
    problems.push('Two buttons cannot do the same thing.');
  }
  return problems.join(' ');
};

/** An offer whose time has come: the bot is sending it now. */
const isDue = (c) => c.scheduled_at && new Date(c.scheduled_at) <= new Date();

/** A past offer in the shape of a template, so it can be opened and sent again. */
const asDraft = (campaign) => ({
  id: '',
  image: campaign.image_url || '',
  caption: campaign.caption || '',
  buttons: (campaign.buttons || []).map(({ id, title }) => ({ id, title })),
});

/** The first line of the caption, without WhatsApp's formatting marks. */
const headline = (campaign) =>
  (campaign.caption || '').split('\n').find((l) => l.trim())?.replace(/[*_~`]/g, '').trim() ||
  'Offer';

const QUALITY = { GREEN: 'High', YELLOW: 'Medium', RED: 'Low' };

/** How many more paid sends today's limit allows; Infinity when unlimited. */
const paidLeftOf = (limit) => (!limit ? 0 : limit.left < 0 ? Infinity : limit.left);

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Who a broadcast reaches: subscribed contacts inside the 24-hour window,
  // the same rule the bot applies when it sends.
  const [audience, setAudience] = useState(null); // { reachable, subscribed }

  const [composerOpen, setComposerOpen] = useState(false);
  const [form, setForm] = useState(emptyOffer);
  const [templateId, setTemplateId] = useState('');
  const [when, setWhen] = useState('now');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [uploadSource, setUploadSource] = useState('url');
  const [localPreview, setLocalPreview] = useState('');

  // Who outside the free window gets it: 'free' sends only inside it,
  // 'everyone' also sends an approved WhatsApp template, which Meta bills.
  const [reach, setReach] = useState('free');
  const [waTemplates, setWaTemplates] = useState({ loading: false, list: [], error: '' });
  const [waTemplateKey, setWaTemplateKey] = useState('');
  const [filledFrom, setFilledFrom] = useState('');

  const [modal, setModal] = useState({ open: false, title: '', message: '', type: 'success' });
  const [confirmCancel, setConfirmCancel] = useState(null);

  // Meta's paid-message limit: different people per 24 hours, and how many
  // of those today has left. The bot holds back anyone past it.
  const [limit, setLimit] = useState(null);
  const [billing, setBilling] = useState(null); // spend, price and balance
  const [maxPaid, setMaxPaid] = useState('');
  const [report, setReport] = useState(null); // the offer whose delivery report is open
  const [refreshKey, setRefreshKey] = useState(0); // reloads the contacts list

  // Uploads are served by the bot at /api/uploads; the bot rewrites the
  // address to its public one before handing it to Meta.
  const API_BASE = import.meta.env.VITE_API_URL || window.location.origin;

  // `quiet` is the background refresh while an offer is going out: it
  // updates the rows without flashing the loading state.
  const load = useCallback(async (quiet = false) => {
    setLoadError('');
    try {
      if (!quiet) setLoading(true);
      const { data } = await getCampaigns({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      // Quizzes are not part of this panel; any old ones are left out.
      setCampaigns((data.data || []).filter((c) => c.type === 'poster'));
      setTotal(data.total || 0);
    } catch (err) {
      console.error(err);
      setLoadError('Could not load your offers. The server did not respond — try again.');
    } finally {
      setLoading(false);
    }
  }, [page]);

  const loadAudience = useCallback(() => {
    getContacts()
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : data?.data || [];
        const subscribed = list.filter((c) => !c.opt_out);
        setAudience({
          subscribed: subscribed.length,
          reachable: subscribed.filter((c) => isInWindow(c.last_incoming_at)).length,
        });
      })
      .catch((err) => {
        console.error(err);
        setAudience(null);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While an offer is going out, keep the list current so it flips to Sent
  // by itself.
  const inFlight = campaigns.some(
    (c) => c.status === 'sending' || (c.status === 'scheduled' && isDue(c)),
  );
  useEffect(() => {
    if (!inFlight) return undefined;
    const interval = setInterval(() => load(true), 3000);
    return () => clearInterval(interval);
  }, [inFlight, load]);

  const loadLimit = useCallback(() => {
    getMessagingLimit()
      .then(({ data }) => setLimit(data))
      .catch((err) => {
        console.error(err);
        setLimit(null);
      });
  }, []);

  const loadBilling = useCallback((fresh = false) => {
    getBilling(fresh)
      .then(({ data }) => setBilling(data))
      .catch((err) => {
        console.error(err);
        setBilling(null);
      });
  }, []);

  useEffect(() => {
    loadAudience();
    loadLimit();
    loadBilling();
  }, [loadAudience, loadLimit, loadBilling]);

  // Once an offer finishes going out, the limit, spend and contacts change.
  const wasInFlight = useRef(false);
  useEffect(() => {
    if (wasInFlight.current && !inFlight) {
      loadLimit();
      loadBilling(true);
      setRefreshKey((k) => k + 1);
    }
    wasInFlight.current = inFlight;
  }, [inFlight, loadLimit, loadBilling]);

  // Free the object URL behind an uploaded photo's preview.
  useEffect(() => () => localPreview && URL.revokeObjectURL(localPreview), [localPreview]);

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const openComposer = (template) => {
    setForm(emptyOffer());
    setTemplateId('');
    setWhen('now');
    setUploadSource('url');
    setLocalPreview('');
    setErrors({});
    setReach('free');
    setWaTemplateKey('');
    setFilledFrom('');
    setMaxPaid('');
    if (template) applyTemplate(template);
    setComposerOpen(true);
    loadAudience();
    loadLimit();
    loadBilling();
  };

  const loadWaTemplates = useCallback(() => {
    setWaTemplates((s) => ({ ...s, loading: true, error: '' }));
    getWhatsAppTemplates()
      .then(({ data }) => setWaTemplates({ loading: false, list: data?.data || [], error: data?.error || '' }))
      .catch((err) => {
        console.error(err);
        setWaTemplates({ loading: false, list: [], error: 'Could not read your WhatsApp templates. Try again.' });
      });
  }, []);

  const chooseReach = (value) => {
    setReach(value);
    if (value === 'everyone' && waTemplates.list.length === 0 && !waTemplates.loading) loadWaTemplates();
  };

  const waTemplate = waTemplates.list.find((t) => waKey(t) === waTemplateKey);

  const applyTemplate = (template) => {
    setTemplateId(template.id);
    setUploadSource('url');
    setLocalPreview('');
    setForm((f) => ({
      ...f,
      image_url: template.image,
      caption: template.caption,
      buttons: template.buttons.map((b) => ({ ...b })),
      localFile: undefined,
    }));
    setErrors({});
  };

  // Choosing a WhatsApp template fills the offer's message and buttons from
  // it, so people inside the free window get the same text and buttons as
  // everyone who gets the template, and each button does the same thing.
  const chooseWaTemplate = (key) => {
    setWaTemplateKey(key);
    const t = waTemplates.list.find((x) => waKey(x) === key);
    if (!t) return;
    setForm((f) => ({
      ...f,
      caption: waText(t, 'BODY') || f.caption,
      buttons: waButtons(t)
        .slice(0, MAX_BUTTONS)
        .map((b, i) => ({ id: t.actions?.[i] || guessAction(b.text), title: b.text })),
    }));
    setFilledFrom(t.name);
  };

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const setButton = (index, key, value) =>
    setForm((f) => ({
      ...f,
      buttons: f.buttons.map((b, i) => (i === index ? { ...b, [key]: value } : b)),
    }));

  const addButton = () =>
    setForm((f) => {
      const used = new Set(f.buttons.map((b) => b.id));
      const next = BUTTON_ACTIONS.find((a) => !used.has(a.value)) || BUTTON_ACTIONS[0];
      return { ...f, buttons: [...f.buttons, { id: next.value, title: '' }] };
    });

  const removeButton = (index) =>
    setForm((f) => ({ ...f, buttons: f.buttons.filter((_, i) => i !== index) }));

  const chooseFile = (file) => {
    setField('localFile', file);
    setLocalPreview(file ? URL.createObjectURL(file) : '');
  };

  const validate = () => {
    const next = {};
    if (uploadSource === 'url' && !form.image_url.trim()) next.image = 'Add a photo — paste its link or upload one.';
    if (uploadSource === 'local' && !form.localFile) next.image = 'Choose a photo to upload.';
    if (!form.caption.trim()) next.caption = 'Write the offer people will read.';
    if (when === 'later' && !form.scheduled_at) next.scheduled_at = 'Choose when it should go out.';
    const problem = buttonProblem(form.buttons);
    if (problem) next.buttons = problem;
    if (reach === 'everyone' && !waTemplate) next.waTemplate = 'Choose the approved template to send to everyone else.';
    if (reach === 'everyone' && maxPaid !== '') {
      const n = Number(maxPaid);
      if (!Number.isInteger(n) || n < 1) next.maxPaid = 'Enter a whole number, 1 or more.';
      else if (n > paidLeftOf(limit)) next.maxPaid = `Today’s limit has only ${paidLeftOf(limit)} left.`;
    }
    if (paidPlan?.after != null && paidPlan.after < 0) {
      next.maxPaid = `Not enough balance: up to ${rupees(paidPlan.cost)} needed, about ${rupees(
        billing.balance_estimate,
      )} left. Top up in WhatsApp Manager and update the balance, or send to fewer people.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!validate()) return;
    setSubmitting(true);

    try {
      let imageURL = form.image_url.trim();
      if (uploadSource === 'local') {
        const { data } = await uploadImage(form.localFile);
        imageURL = `${API_BASE}/api${data.url}`;
      }

      // "Send now" is a schedule for this minute: the bot's broadcaster runs
      // every minute and picks it up on its next pass.
      const at = when === 'now' ? new Date() : new Date(form.scheduled_at);

      await createCampaign({
        type: 'poster',
        image_url: imageURL,
        caption: form.caption,
        scheduled_at: at.toISOString(),
        buttons: form.buttons.map((b) => ({ id: b.id, title: b.title.trim() })),
        template_name: reach === 'everyone' ? waTemplate.name : '',
        template_lang: reach === 'everyone' ? waTemplate.language : '',
        max_paid: reach === 'everyone' && maxPaid !== '' ? Number(maxPaid) : 0,
      });

      setComposerOpen(false);
      setModal({
        open: true,
        title: when === 'now' ? 'Offer on its way' : 'Offer scheduled',
        message:
          (when === 'now'
            ? 'It is going out now to everyone who messaged in the last 24 hours'
            : 'It will go out at the time you set to everyone who messaged in the 24 hours before') +
          (reach === 'everyone'
            ? `, and as the “${waTemplate.name}” template to every other subscribed contact.`
            : '.') +
          (when === 'now' ? '' : ' You can cancel it from this page until then.'),
        type: 'success',
      });
      load();
    } catch (err) {
      console.error(err);
      setModal({
        open: true,
        title: 'Nothing was sent',
        message:
          err.response?.data ||
          'The offer was not saved, so nobody will receive it. Check the fields and try again.',
        type: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    const campaign = confirmCancel;
    if (!campaign) return;
    try {
      await deleteCampaign(campaign.id);
      load();
    } catch (err) {
      console.error(err);
      setModal({
        open: true,
        title: 'Could not cancel it',
        message: 'The offer is still scheduled. Refresh the page and try again.',
        type: 'error',
      });
    }
  };

  // The paid part of the offer if it went now: capped by the daily limit and
  // the number chosen, and its cost if every one of them were delivered.
  const paidPlan = useMemo(() => {
    if (!audience || reach !== 'everyone') return null;
    const need = audience.subscribed - audience.reachable;
    const chosen = maxPaid !== '' ? Number(maxPaid) || 0 : Infinity;
    const count = Math.max(0, Math.min(need, paidLeftOf(limit), chosen));
    const cost = billing ? count * billing.rate : null;
    const after = billing?.balance_estimate != null && cost != null ? billing.balance_estimate - cost : null;
    return { need, count, held: need - count, cost, after };
  }, [audience, reach, limit, maxPaid, billing]);

  const reachLine = useMemo(() => {
    if (audience === null) return 'The number of recipients could not be read just now.';
    if (reach === 'everyone' && paidPlan) {
      return `${audience.reachable} free, and ${paidPlan.count} as a paid template${
        paidPlan.cost != null ? ` (up to ${rupees(paidPlan.cost)})` : ''
      }${paidPlan.held > 0 ? `; ${paidPlan.held} held back by the limit, for a retry later` : ''}. Counted as of now.`;
    }
    if (audience.reachable === 0) {
      return 'Right now nobody has messaged in the last 24 hours, so this would reach nobody.';
    }
    return `Goes free to ${audience.reachable} of ${audience.subscribed} subscribed ${
      audience.subscribed === 1 ? 'contact' : 'contacts'
    } — the ones who messaged in the last 24 hours.`;
  }, [audience, reach, paidPlan]);

  const previewCaption = form.caption.trim();
  const previewImage = uploadSource === 'local' ? localPreview : form.image_url.trim();

  return (
    <>
      <PageHeader
        eyebrow="Marketing"
        title="Broadcasts"
        intro="Send an offer — a photo, a few lines and buttons to tap. People who messaged Connect in the last 24 hours get it free; everyone else needs a paid template, within WhatsApp's daily limit."
        action={
          <Button onClick={() => openComposer()}>
            <Plus />
            New offer
          </Button>
        }
      />

      <div className="mb-8 grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(0,1.2fr)]">
        <div className="rounded-xl border border-border bg-white px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">Free now</p>
          <p className="mt-1 font-heading text-2xl font-bold tabular-nums text-ink">
            {audience === null ? '—' : audience.reachable}
            <span className="ml-1.5 text-[13px] font-normal text-text-secondary">
              of {audience === null ? '—' : audience.subscribed} subscribed
            </span>
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
            Messaged in the last 24 hours, so an offer reaches them at no charge and does not count toward the limit.
          </p>
        </div>

        <div className="rounded-xl border border-border bg-white px-5 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-secondary">
              Paid marketing — WhatsApp limit
            </p>
            {limit?.quality && (
              <p className="text-[12px] text-text-secondary">
                Number quality:{' '}
                <span className={limit.quality === 'GREEN' ? 'text-success' : limit.quality === 'RED' ? 'text-danger' : 'text-warning'}>
                  {QUALITY[limit.quality] || limit.quality}
                </span>
              </p>
            )}
          </div>
          {limit === null ? (
            <p className="mt-2 text-[13px] text-text-secondary">The limit could not be read just now.</p>
          ) : limit.limit === 0 ? (
            <p className="mt-1 font-heading text-2xl font-bold text-ink">Unlimited</p>
          ) : (
            <>
              <div className="mt-1 grid grid-cols-3 gap-3">
                <div>
                  <p className="font-heading text-2xl font-bold tabular-nums text-ink">{limit.limit}</p>
                  <p className="text-[12px] text-text-secondary">people / 24 hours</p>
                </div>
                <div>
                  <p className="font-heading text-2xl font-bold tabular-nums text-ink">{limit.used}</p>
                  <p className="text-[12px] text-text-secondary">sent in last 24h</p>
                </div>
                <div>
                  <p className={`font-heading text-2xl font-bold tabular-nums ${limit.left === 0 ? 'text-danger' : 'text-success'}`}>
                    {limit.left}
                  </p>
                  <p className="text-[12px] text-text-secondary">left now</p>
                </div>
              </div>
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper"
                role="meter"
                aria-label="Paid limit used"
                aria-valuemin={0}
                aria-valuemax={limit.limit}
                aria-valuenow={Math.min(limit.used, limit.limit)}
              >
                <div
                  className={`h-full rounded-full ${limit.left === 0 ? 'bg-danger' : 'bg-ink'}`}
                  style={{ width: `${Math.min(100, (limit.used / limit.limit) * 100)}%` }}
                />
              </div>
            </>
          )}
          <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
            {limit?.problem ||
              'A paid template can reach this many different people in any 24 hours; the window rolls, so each send frees up a day after it went. Offers never go past it — the rest are held back for a retry. Meta charges only for messages delivered.'}
          </p>
        </div>

        <WhatsAppBalance billing={billing} onChange={setBilling} />
      </div>

      {/* ── Start from a template ─────────────────────────────────────── */}
      <Reveal>
        <section className="mb-8">
          <p className="eyebrow mb-3">Start from a template</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            {TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => openComposer(template)}
                className="group overflow-hidden rounded-xl border border-border bg-white text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/40"
              >
                <img
                  src={template.image}
                  alt=""
                  loading="lazy"
                  className="aspect-[4/3] w-full bg-paper object-cover"
                />
                <p className="px-3 py-2.5 text-[13px] font-medium text-ink group-hover:text-primary">
                  {template.label}
                </p>
              </button>
            ))}
          </div>
        </section>
      </Reveal>

      {loadError && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-xl border border-danger/25 bg-danger-light px-4 py-3"
        >
          <AlertCircle aria-hidden="true" className="mt-1 size-4 shrink-0 text-danger" />
          <div>
            <p className="text-[13px] font-medium text-danger">{loadError}</p>
            <button
              type="button"
              onClick={() => load()}
              className="mt-1 text-[13px] font-medium text-danger underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      <Reveal delay={0.04}>
        <Card>
          <Table>
            <TableHeader>
              <tr>
                <TableHead className="w-[46%]">Offer</TableHead>
                <TableHead className="w-36 text-center">Status</TableHead>
                <TableHead className="w-56 text-center">Goes out</TableHead>
                <TableHead className="w-44 text-center">Delivery</TableHead>
                <TableHead className="w-24 text-right">Cancel</TableHead>
              </tr>
            </TableHeader>

            <TableBody>
              {campaigns.map((campaign) => {
                const status = getBroadcastStatus(
                  campaign.status === 'scheduled' && isDue(campaign) ? 'sending' : campaign.status,
                );
                return (
                  <TableRow key={campaign.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => openComposer(asDraft(campaign))}
                        aria-label={`Open “${headline(campaign)}” to send again`}
                        className="group flex w-full items-start gap-3 text-left"
                      >
                        {campaign.image_url ? (
                          <img
                            src={campaign.image_url}
                            alt=""
                            className="size-12 shrink-0 rounded-lg bg-paper object-cover"
                          />
                        ) : (
                          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-paper text-titanium-700">
                            <ImageIcon className="size-4" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-ink group-hover:text-primary">{headline(campaign)}</p>
                          {campaign.buttons?.length > 0 && (
                            <p className="mt-1 text-[12px] leading-snug text-text-secondary">
                              Buttons: {campaign.buttons.map((b) => b.title).join(' · ')}
                            </p>
                          )}
                          {campaign.template_name && (
                            <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">
                              Everyone else: template “{campaign.template_name}”
                            </p>
                          )}
                          {campaign.retry_of > 0 && (
                            <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">
                              Retry of offer #{campaign.retry_of}, to the contacts it missed
                            </p>
                          )}
                        </div>
                      </button>
                    </TableCell>

                    <TableCell className="text-center">
                      <Badge variant={status.badge}>
                        <span aria-hidden="true" className={`size-1.5 rounded-full ${status.dot}`} />
                        {status.label}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-center text-text-secondary">
                      {campaign.scheduled_at
                        ? format(parseISO(campaign.scheduled_at), "d MMM yyyy 'at' h:mm a")
                        : '—'}
                    </TableCell>

                    <TableCell className="text-center tabular-nums text-text-secondary">
                      {campaign.status === 'sent' || campaign.status === 'sending' ? (
                        <button
                          type="button"
                          onClick={() => setReport(campaign)}
                          aria-label={`Delivery report for “${headline(campaign)}”`}
                          className="group inline-flex flex-col items-center gap-0.5 rounded-lg px-2 py-1 hover:bg-paper"
                        >
                          {campaign.delivery ? (
                            <>
                              <span className="text-[13px] text-ink">
                                <span className="font-medium text-success">{campaign.delivery.delivered}</span> of{' '}
                                {campaign.delivery.sent} delivered
                              </span>
                              {campaign.delivery.paid_delivered > 0 && billing && (
                                <span className="text-[12px] text-text-secondary">
                                  ≈ {rupees(campaign.delivery.paid_delivered * billing.rate)} charged
                                </span>
                              )}
                              {(campaign.delivery.failed > 0 || campaign.delivery.skipped > 0) && (
                                <span className="text-[12px]">
                                  {campaign.delivery.failed > 0 && (
                                    <span className="text-danger">{campaign.delivery.failed} failed</span>
                                  )}
                                  {campaign.delivery.failed > 0 && campaign.delivery.skipped > 0 && ' · '}
                                  {campaign.delivery.skipped > 0 && (
                                    <span className="text-warning">{campaign.delivery.skipped} held</span>
                                  )}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-[13px]">Sent to {campaign.total_sent}</span>
                          )}
                          <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary group-hover:text-primary">
                            <FileBarChart className="size-3" /> Report
                          </span>
                        </button>
                      ) : (
                        '—'
                      )}
                    </TableCell>

                    <TableCell className="text-right">
                      {campaign.status === 'scheduled' && !isDue(campaign) && (
                        <Button
                          variant="destructive-outline"
                          size="icon-xs"
                          aria-label={`Cancel the offer “${headline(campaign)}”`}
                          onClick={() => setConfirmCancel(campaign)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}

              {campaigns.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center">
                    <Megaphone aria-hidden="true" className="mx-auto size-6 text-titanium-300" />
                    <p className="mt-3 font-heading text-base font-bold uppercase tracking-tight text-ink">
                      No offers sent yet
                    </p>
                    <p className="mx-auto mt-2 max-w-[46ch] text-[13px] leading-relaxed text-text-secondary">
                      Pick a template above, or use “New offer” to write your own.
                    </p>
                  </td>
                </tr>
              )}

              {loading && (
                <tr>
                  <td colSpan={5} className="px-5 py-16 text-center">
                    <span className="mx-auto block size-6 animate-spin rounded-full border-2 border-line border-t-ink" />
                  </td>
                </tr>
              )}
            </TableBody>
          </Table>

          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-4 border-t border-border bg-paper px-5 py-3.5">
              <p className="text-[13px] text-text-secondary">
                Page <span className="font-medium tabular-nums text-ink">{page + 1}</span> of{' '}
                <span className="tabular-nums">{lastPage + 1}</span>
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
      </Reveal>

      <OfferContacts refreshKey={refreshKey} />

      <DeliveryReport
        campaign={report}
        onClose={() => setReport(null)}
        onRetried={() => {
          load(true);
          loadLimit();
          loadBilling(true);
        }}
      />

      {/* ── Composer ────────────────────────────────────────────────────── */}

      <Dialog open={composerOpen} onClose={() => setComposerOpen(false)} size="xl" labelledBy="composer-title">
        <DialogHeader
          id="composer-title"
          eyebrow="Marketing"
          title="New offer"
          description="Pick a template or write your own. The preview shows exactly what customers get."
          onClose={() => setComposerOpen(false)}
        />

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogBody>
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label>Template</Label>
                  <div className="flex flex-wrap gap-2">
                    {TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => applyTemplate(template)}
                        className={`rounded-full border px-3 py-1 text-[12px] font-medium transition-colors ${
                          templateId === template.id
                            ? 'border-primary bg-primary-light text-primary'
                            : 'border-border bg-white text-body-text hover:border-primary/40'
                        }`}
                      >
                        {template.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Photo</Label>
                  <Tabs value={uploadSource} onValueChange={setUploadSource} items={SOURCE_TABS} layoutId="offer-source" />
                  {uploadSource === 'url' ? (
                    <Input
                      aria-label="Photo link"
                      value={form.image_url}
                      onChange={(e) => setField('image_url', e.target.value)}
                      placeholder="https://…/photo.jpg"
                      aria-invalid={!!errors.image}
                    />
                  ) : (
                    <>
                      <input
                        type="file"
                        accept="image/*"
                        aria-label="Photo file"
                        onChange={(e) => chooseFile(e.target.files[0])}
                        className="w-full rounded-lg border border-dashed border-line-strong bg-paper p-4 text-[13px] text-text-secondary file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-[12px] file:font-medium file:text-white"
                      />
                      {form.localFile && (
                        <p className="flex items-center gap-1.5 text-[12px] font-medium text-success">
                          <CheckCircle2 aria-hidden="true" className="size-3.5" />
                          {form.localFile.name}
                        </p>
                      )}
                    </>
                  )}
                  {errors.image && (
                    <p role="alert" className="text-[12px] text-danger">{errors.image}</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="caption">Message</Label>
                  <Textarea
                    id="caption"
                    rows={6}
                    value={form.caption}
                    onChange={(e) => setField('caption', e.target.value)}
                    placeholder="☀️ *Good morning!* Breakfast is ready…"
                    aria-invalid={!!errors.caption}
                  />
                  <FormattingHint />
                  {errors.caption && (
                    <p role="alert" className="text-[12px] text-danger">{errors.caption}</p>
                  )}
                </div>

                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-ink">Buttons</legend>
                  <p className="text-[12px] leading-relaxed text-text-secondary">
                    Tapping one opens that part of the bot — and reopens that person’s free
                    24-hour window.
                  </p>
                  {form.buttons.map((button, index) => {
                    const count = charCount(button.title);
                    const tooLong = count > BUTTON_TEXT_LIMIT;
                    return (
                      <div key={index} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_1fr_auto]">
                        <div className="space-y-1">
                          <Input
                            aria-label={`Button ${index + 1} text`}
                            value={button.title}
                            onChange={(e) => setButton(index, 'title', e.target.value)}
                            placeholder="🎁 See Offers"
                            aria-invalid={!!errors.buttons && (!button.title.trim() || tooLong)}
                          />
                          <p className={`font-mono text-[11px] tabular-nums ${tooLong ? 'text-danger' : 'text-text-secondary'}`}>
                            {count}/{BUTTON_TEXT_LIMIT}
                          </p>
                        </div>
                        <div className="order-last col-span-2 sm:order-none sm:col-span-1">
                          <Select
                            aria-label={`Button ${index + 1} action`}
                            value={button.id}
                            onChange={(e) => setButton(index, 'id', e.target.value)}
                          >
                            {BUTTON_ACTIONS.map((action) => (
                              <option key={action.value} value={action.value}>
                                {action.label}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove button ${index + 1}`}
                          onClick={() => removeButton(index)}
                        >
                          <X />
                        </Button>
                      </div>
                    );
                  })}
                  {form.buttons.length < MAX_BUTTONS && (
                    <Button type="button" variant="outline" size="sm" onClick={addButton}>
                      <Plus />
                      Add a button
                    </Button>
                  )}
                  {errors.buttons && (
                    <p role="alert" className="text-[12px] text-danger">{errors.buttons}</p>
                  )}
                </fieldset>

                <div className="space-y-2">
                  <Label>Who gets it</Label>
                  <Tabs value={reach} onValueChange={chooseReach} items={AUDIENCE_TABS} layoutId="offer-reach" />
                  {reach === 'free' ? (
                    <p className="text-[12px] leading-relaxed text-text-secondary">
                      Free, but only reaches people who messaged in the 24 hours before it goes out.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[12px] leading-relaxed text-text-secondary">
                        People in the last 24 hours get this offer free. Every other subscribed contact gets an
                        approved WhatsApp marketing template with this photo, and Meta charges for each one
                        delivered.
                      </p>
                      {audience && limit && (
                        <div className="space-y-2 rounded-lg border border-border bg-paper px-3 py-3 text-[12px] leading-relaxed">
                          <p className="text-body-text">
                            Paid: <span className="font-medium tabular-nums text-ink">{audience.subscribed - audience.reachable}</span>{' '}
                            contacts need the template. Today’s limit has{' '}
                            <span className="font-medium tabular-nums text-ink">
                              {limit.left < 0 ? 'no cap' : limit.left}
                            </span>{' '}
                            left of {limit.limit === 0 ? 'unlimited' : limit.limit}. Contacts who have not had an offer
                            yet go first.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Label htmlFor="max-paid" className="text-[12px]">
                              Send the paid template to at most
                            </Label>
                            <Input
                              id="max-paid"
                              type="number"
                              min={1}
                              max={Number.isFinite(paidLeftOf(limit)) ? paidLeftOf(limit) : undefined}
                              inputMode="numeric"
                              className="h-8 w-24"
                              placeholder={String(
                                Math.min(audience.subscribed - audience.reachable, paidLeftOf(limit)),
                              )}
                              value={maxPaid}
                              onChange={(e) => setMaxPaid(e.target.value)}
                              aria-invalid={!!errors.maxPaid}
                            />
                            <span className="text-text-secondary">people</span>
                          </div>
                          {paidPlan && billing && (
                            <div className="grid grid-cols-3 gap-2 border-t border-border pt-2">
                              <div>
                                <p className="font-medium tabular-nums text-ink">{paidPlan.count}</p>
                                <p className="text-text-secondary">paid sends</p>
                              </div>
                              <div>
                                <p className="font-medium tabular-nums text-ink">up to {rupees(paidPlan.cost)}</p>
                                <p className="text-text-secondary">at {rupees(billing.rate, 4)} each, if all arrive</p>
                              </div>
                              <div>
                                <p
                                  className={`font-medium tabular-nums ${
                                    paidPlan.after != null && paidPlan.after < 0 ? 'text-danger' : 'text-ink'
                                  }`}
                                >
                                  {paidPlan.after != null ? rupees(paidPlan.after) : '—'}
                                </p>
                                <p className="text-text-secondary">
                                  {paidPlan.after != null ? 'balance after, at least' : 'enter the balance to see this'}
                                </p>
                              </div>
                            </div>
                          )}
                          {paidPlan?.held > 0 && (
                            <p className="text-warning">
                              {paidPlan.held} more need the template but are over the limit. They are held back and
                              shown in the report, ready for a retry.
                            </p>
                          )}
                          {errors.maxPaid && (
                            <p role="alert" className="text-danger">{errors.maxPaid}</p>
                          )}
                        </div>
                      )}
                      {waTemplates.loading ? (
                        <p className="text-[12px] text-text-secondary">Loading your templates…</p>
                      ) : waTemplates.error ? (
                        <p role="alert" className="text-[12px] text-danger">
                          {waTemplates.error}{' '}
                          <button type="button" onClick={loadWaTemplates} className="underline underline-offset-2">
                            Try again
                          </button>
                        </p>
                      ) : (
                        <>
                          <Select
                            aria-label="WhatsApp template"
                            value={waTemplateKey}
                            onChange={(e) => chooseWaTemplate(e.target.value)}
                            aria-invalid={!!errors.waTemplate}
                          >
                            <option value="">
                              {waTemplates.list.length ? 'Choose a template' : 'No marketing templates yet'}
                            </option>
                            {waTemplates.list.map((t) => (
                              <option key={waKey(t)} value={waKey(t)} disabled={!!t.problem}>
                                {t.name} ({t.language}){t.problem ? ` — ${t.problem}` : ''}
                              </option>
                            ))}
                          </Select>
                          {waTemplate && (
                            <p className="whitespace-pre-line rounded-lg border border-border bg-paper px-3 py-2 text-[12px] leading-relaxed text-body-text">
                              {waText(waTemplate, 'BODY')}
                            </p>
                          )}
                          {waTemplate && filledFrom === waTemplate.name && (
                            <p className="text-[12px] font-medium text-success">
                              Message and buttons filled in from this template.
                            </p>
                          )}
                          {waTemplate && waButtons(waTemplate).length > 0 && (
                            <p className="text-[12px] leading-relaxed text-text-secondary">
                              Template buttons:{' '}
                              {waButtons(waTemplate)
                                .map((b, i) => {
                                  const action = waTemplate.actions?.[i] || form.buttons[i]?.id;
                                  return `${b.text} → ${action ? actionLabel(action).toLowerCase() : 'nothing'}`;
                                })
                                .join(' · ')}
                              . Change them on the Templates page.
                            </p>
                          )}
                        </>
                      )}
                      {errors.waTemplate && (
                        <p role="alert" className="text-[12px] text-danger">{errors.waTemplate}</p>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>When</Label>
                  <Tabs value={when} onValueChange={setWhen} items={WHEN_TABS} layoutId="offer-when" />
                  {when === 'later' && (
                    <>
                      <Input
                        type="datetime-local"
                        aria-label="Send at"
                        className="sm:max-w-[16rem]"
                        value={form.scheduled_at}
                        onChange={(e) => setField('scheduled_at', e.target.value)}
                        aria-invalid={!!errors.scheduled_at}
                      />
                      {errors.scheduled_at && (
                        <p role="alert" className="text-[12px] text-danger">{errors.scheduled_at}</p>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="lg:sticky lg:top-0 lg:self-start">
                <WhatsAppPreview
                  message={previewCaption}
                  image={previewImage}
                  buttons={form.buttons}
                  empty="Pick a template or write a message to see it here."
                />
              </div>
            </div>
          </DialogBody>

          <DialogFooter className="justify-between">
            <p className="text-[12px] leading-relaxed text-text-secondary">{reachLine}</p>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={() => setComposerOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                <Send />
                {submitting ? 'Saving…' : when === 'now' ? 'Send offer' : 'Schedule offer'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmModal
        isOpen={!!confirmCancel}
        onClose={() => setConfirmCancel(null)}
        onConfirm={handleCancel}
        type="danger"
        title="Cancel this offer?"
        message={confirmCancel ? `“${headline(confirmCancel)}” will not be sent.` : ''}
        confirmText="Cancel offer"
      />

      <Modal
        isOpen={modal.open}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        title={modal.title}
        message={modal.message}
        type={modal.type}
      />
    </>
  );
}
