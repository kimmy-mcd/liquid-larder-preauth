// Shared hold-placement logic — identical copy deployed in preauth-cron,
// preauth-public and preauth-staff. Keep all three in sync when editing.

// deno-lint-ignore-file no-explicit-any

export const VENUE_KEYS: Record<string, string> = {
  'Bistecca': 'BISTECCA',
  'The Gidley': 'GIDLEY',
  "Alfie's": 'ALFIES',
  'Liquid & Larder': 'LIQUIDLARDER',
};

export function stripeKeyFor(venue: string): string {
  const suffix = VENUE_KEYS[venue];
  const key = suffix ? Deno.env.get(`STRIPE_SECRET_KEY_${suffix}`) : undefined;
  if (!key) throw new Error(`No Stripe key configured for ${venue}`);
  return key;
}

export async function stripeReq(
  secretKey: string,
  path: string,
  params: Record<string, string> = {},
  method = 'POST',
): Promise<any> {
  let url = `https://api.stripe.com/v1/${path}`;
  let body: BodyInit | undefined;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    body = new URLSearchParams(params);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? 'Stripe request failed');
  return data;
}

// Today's date (YYYY-MM-DD) in Australia/Sydney — all hold timing is Sydney-based.
export function sydneyToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

// Whole days from `today` to `bookingDate` (both YYYY-MM-DD). Negative = past.
export function daysUntil(bookingDate: string, today: string): number {
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = bookingDate.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Guest email (Resend). Branded to match the payment page: warm paper base,
// brand green, LL brandmark, Gilda/serif headings. All sends are best-effort
// and never throw — an email failure must never affect a hold, capture or
// refund. Callers skip sending when there is no guest email address.
// ---------------------------------------------------------------------------

const LL_BRANDMARK =
  'https://www.liquidandlarder.com.au/wp-content/uploads/cropped-LLBrandmark_Black_Sand_Instagram-270x270.jpg';
const LL_TERMS_URL = 'https://www.liquidandlarder.com.au/credit-card-authorisation-terms/';
const LL_FROM = 'Liquid & Larder <no-reply@liquidandlarder.com.au>';

export function fmtAudCents(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}

// Long human date ("Sunday, 20 July 2026") from a YYYY-MM-DD string. Pinned to
// noon UTC so the calendar date never rolls over during formatting.
function fmtDateLong(dateStr: string): string {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Low-level Resend send. Returns true on success; never throws.
export async function sendGuestEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: LL_FROM, to: [to], subject, html }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

const HAIRLINE = 'rgba(29,62,59,0.08)';

// Shared branded shell: centred 480px card on warm paper, brandmark on top,
// secure-handling footer below.
function emailShell(innerHtml: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#faf8f4;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f4;">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;">` +
    `<tr><td align="center" style="padding-bottom:22px;">` +
    `<img src="${LL_BRANDMARK}" width="58" height="58" alt="Liquid &amp; Larder" style="display:block;border-radius:12px;"></td></tr>` +
    `<tr><td style="background:#ffffff;border:1px solid ${HAIRLINE};border-radius:20px;padding:34px 30px;` +
    `font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#242c2a;">${innerHtml}</td></tr>` +
    `<tr><td align="center" style="padding:20px 14px 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;` +
    `color:#646c68;font-size:11px;line-height:1.8;">` +
    `Your card details are held securely by Stripe, our payment provider.<br>` +
    `Liquid &amp; Larder never sees or stores your card number.</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

function pill(label: string): string {
  return `<div style="display:inline-block;background:#f2ecdf;color:#1d3e3b;border-radius:999px;` +
    `padding:6px 14px;font-size:10px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;` +
    `margin-bottom:18px;">${label}</div>`;
}

function heading(text: string): string {
  return `<h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:22px;` +
    `line-height:1.35;color:#1d3e3b;margin:0 0 16px;">${text}</h1>`;
}

function amountBox(label: string, amount: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="margin:16px 0 6px;background:#f2ecdf;border-radius:14px;"><tr>` +
    `<td style="padding:16px 18px;color:#646c68;text-transform:uppercase;letter-spacing:0.1em;font-size:10.5px;">${label}</td>` +
    `<td align="right" style="padding:16px 18px;font-family:Georgia,serif;font-size:26px;color:#1d3e3b;">${amount}</td>` +
    `</tr></table>`;
}

function detailRow(label: string, value: string, last = false): string {
  const border = last ? '' : `border-bottom:1px solid ${HAIRLINE};`;
  return `<tr><td style="padding:12px 0;${border}color:#646c68;text-transform:uppercase;` +
    `letter-spacing:0.1em;font-size:10.5px;white-space:nowrap;">${label}</td>` +
    `<td align="right" style="padding:12px 0;${border}font-weight:500;font-size:13.5px;">${value}</td></tr>`;
}

// Pre-authorisation confirmation — sent when a hold is placed. "date of use",
// never "booking"; no dashes in the guest-facing copy; the cardholder may not
// be the person attending, so avoid "your visit" phrasing.
export function preauthHoldEmail(row: any): { subject: string; html: string } {
  const venue = esc(row.venue_name);
  const first = esc(String(row.guest_name ?? '').split(' ')[0] || 'there');
  const amount = fmtAudCents(row.max_amount_cents);
  const dateStr = fmtDateLong(row.booking_date);
  const purpose = row.notes ? esc(row.notes) : '';

  const rows = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
    detailRow('Venue', venue) +
    (purpose ? detailRow('For', purpose) : '') +
    detailRow('Date of use', dateStr, true) +
    `</table>`;

  const inner =
    pill('Card pre-authorisation') +
    heading(`Hi ${first}, a hold has been placed on your card`) +
    `<p style="font-size:14px;line-height:1.65;color:#242c2a;margin:0 0 6px;">This confirms a temporary ` +
    `pre-authorisation on your card for ${venue}, for the date of use shown below. It is a hold, not a payment, ` +
    `and no money has left your account.</p>` +
    rows +
    amountBox('Maximum hold', amount) +
    `<p style="font-size:13px;line-height:1.7;color:#646c68;margin:18px 0 0;">On or after the date of use, ${venue} ` +
    `will charge only the final amount owing, and never more than ${amount}. Any amount not used is released back ` +
    `to your card automatically, usually within a few days.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;"><tr>` +
    `<td style="border-radius:999px;background:#1d3e3b;"><a href="${LL_TERMS_URL}" ` +
    `style="display:inline-block;padding:13px 26px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;` +
    `font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#faf8f4;` +
    `text-decoration:none;">View the full terms</a></td></tr></table>`;

  return { subject: `Your card pre-authorisation for ${row.venue_name}`, html: emailShell(inner) };
}

// Refund confirmation — sent by preauth-staff when a refund is issued, because
// the venue Stripe account has customer refund emails turned off.
export function refundEmail(row: any, refundCents: number): { subject: string; html: string } {
  const venue = esc(row.venue_name);
  const first = esc(String(row.guest_name ?? '').split(' ')[0] || 'there');
  const amount = fmtAudCents(refundCents);

  const inner =
    pill('Refund processed') +
    heading(`Hi ${first}, your refund has been processed`) +
    `<p style="font-size:14px;line-height:1.65;color:#242c2a;margin:0 0 6px;">${venue} has refunded the amount ` +
    `below to your card. Please allow a few business days for it to appear on your statement.</p>` +
    amountBox('Refund amount', amount) +
    `<p style="font-size:13px;line-height:1.7;color:#646c68;margin:18px 0 0;">If you have any questions about ` +
    `this refund, please contact ${venue} directly.</p>`;

  return { subject: `Your refund from ${row.venue_name}`, html: emailShell(inner) };
}

export interface HoldResult {
  ok: boolean;
  pi?: string;
  error?: string;
}

// Places the hold for a card_saved request. On success sets status hold_placed.
// On failure records the attempt + error and leaves status unchanged (caller
// decides whether to retry or mark hold_failed). Never throws.
export async function placeHold(admin: any, row: any): Promise<HoldResult> {
  try {
    if (row.status !== 'card_saved') throw new Error(`Not in card_saved state (${row.status})`);
    if (!row.stripe_customer_id || !row.stripe_payment_method_id) {
      throw new Error('Missing saved card details');
    }
    const sk = stripeKeyFor(row.venue_name);
    const pi = await stripeReq(sk, 'payment_intents', {
      amount: String(row.max_amount_cents),
      currency: row.currency || 'aud',
      customer: row.stripe_customer_id,
      payment_method: row.stripe_payment_method_id,
      'payment_method_types[]': 'card',
      capture_method: 'manual',
      confirm: 'true',
      off_session: 'true',
      description: `Pre-auth hold - ${row.venue_name} - ${String(row.notes ?? '')}`.slice(0, 500),
      'metadata[preauth_request_id]': row.id,
      'metadata[token]': row.token,
    });
    if (pi.status !== 'requires_capture') {
      throw new Error(`Unexpected PaymentIntent status: ${pi.status}`);
    }
    await admin.from('preauth_requests').update({
      status: 'hold_placed',
      stripe_payment_intent_id: pi.id,
      hold_placed_at: new Date().toISOString(),
      hold_attempts: (row.hold_attempts ?? 0) + 1,
      hold_last_error: null,
    }).eq('id', row.id);
    await admin.from('preauth_audit').insert({
      request_id: row.id,
      event: 'hold_placed',
      detail: { payment_intent: pi.id, amount_cents: row.max_amount_cents, venue: row.venue_name },
    });

    // Notify the guest that a hold has been placed. Best-effort: never let an
    // email failure affect the hold outcome; skip when there is no email.
    if (row.guest_email) {
      try {
        const { subject, html } = preauthHoldEmail(row);
        await sendGuestEmail(row.guest_email, subject, html);
      } catch (_) { /* email is best-effort */ }
    }

    return { ok: true, pi: pi.id };
  } catch (e) {
    const msg = (e as Error).message;
    try {
      await admin.from('preauth_requests').update({
        hold_attempts: (row.hold_attempts ?? 0) + 1,
        hold_last_error: msg,
      }).eq('id', row.id);
      await admin.from('preauth_audit').insert({
        request_id: row.id,
        event: 'hold_attempt_failed',
        detail: { error: msg },
      });
    } catch (_) { /* audit best-effort */ }
    return { ok: false, error: msg };
  }
}
