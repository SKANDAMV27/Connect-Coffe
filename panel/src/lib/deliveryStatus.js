/**
 * Where one offer stands for one contact — the statuses the bot writes to
 * `campaign_recipients`, moved on by Meta's delivery webhooks. Meta accepting
 * a send is only `sent`; it can still drop the message afterwards, which is
 * why `delivered` is the number that means someone actually got it.
 */
export const DELIVERY_STATUS = {
  sent: {
    label: 'Sent',
    badge: 'muted',
    description: 'WhatsApp accepted it and has not yet said it arrived.',
  },
  delivered: {
    label: 'Delivered',
    badge: 'success',
    description: 'It reached their phone.',
  },
  read: {
    label: 'Read',
    badge: 'success',
    description: 'They opened it.',
  },
  failed: {
    label: 'Failed',
    badge: 'danger',
    description: 'WhatsApp did not deliver it.',
  },
  skipped: {
    label: 'Held back',
    badge: 'warning',
    description: 'Not sent, to stay inside the daily limit. Retry sends it.',
  },
  untracked: {
    label: 'Sent',
    badge: 'muted',
    description: 'Sent before delivery was tracked, so whether it arrived is not known.',
  },
};

export const getDeliveryStatus = (status) =>
  DELIVERY_STATUS[status] || { label: 'Not sent', badge: 'outline', description: 'Has not been sent an offer.' };

/**
 * Plain words for the WhatsApp errors an offer actually runs into, and
 * whether trying again is worth it. Codes are Meta's.
 */
const ERRORS = {
  131049: {
    title: 'Blocked by WhatsApp',
    explain:
      'WhatsApp limits how many marketing messages one person gets from businesses, and is strictest with people who have never messaged the cafe. Not charged.',
    retry: 'Usually fails again if retried soon. Wait a few days, or until they message the cafe.',
  },
  131026: {
    title: 'Cannot receive it',
    explain: 'The number is not on WhatsApp, or is on an old version of the app. Not charged.',
    retry: 'Retrying will not help unless the number is corrected.',
  },
  131050: {
    title: 'Stopped your marketing',
    explain: 'They turned off marketing messages from the cafe in WhatsApp.',
    retry: 'Left out of retries.',
  },
  131047: {
    title: 'Outside the 24-hour window',
    explain: 'The free message only reaches people who messaged in the last 24 hours.',
    retry: 'Retry reaches them once they message, or with a template.',
  },
  131048: {
    title: 'Sending too fast',
    explain: 'WhatsApp slowed the number down because of how people responded to recent messages.',
    retry: 'Retry later.',
  },
  130472: {
    title: "Part of WhatsApp's experiment",
    explain: 'WhatsApp holds back some marketing messages from a small group of people as a test. Not charged.',
    retry: 'Retrying will not help.',
  },
};

export const explainError = (code, message) =>
  ERRORS[code] || {
    title: 'Not delivered',
    explain: message || 'WhatsApp did not say why.',
    retry: 'Retry may work.',
  };

/** "Paid" for template sends, "Free" for ones inside the 24-hour window. */
export const channelLabel = (channel) => (channel === 'template' ? 'Paid' : channel === 'free' ? 'Free' : '');
