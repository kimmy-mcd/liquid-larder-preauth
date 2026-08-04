// Daily pre-authorisation cron (go-live plan steps 11-14 + push notifications).
// Invoked by pg_cron (via pg_net) once a day; authenticated by the
// x-cron-secret header (CRON_SECRET edge secret) — verify_jwt is off.
//
// Each run, in Sydney time:
//   1. expires stale `sent` links whose date of use has passed
//   2. places 7-day holds for `card_saved` requests 0-2 days before the date
//      of use (catch-up window back to 3 days past), one automatic retry
//   3. sends a push notification to superusers for every `hold_placed` request
//      whose date of use has passed — a reminder to capture the final amount
//   4. writes a heartbeat row to preauth_cron_runs
//   5. emails a daily summary via Resend — absence of the email is the alarm;
//      failures flag the subject line
//
// Body { "dry_run": true } reports what would happen without writing,
// charging, emailing or sending push notifications.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { addDays, daysUntil, placeHold, sydneyToday } from './hold.ts';
import { sendToSubs, type PushSubscription } from '../_shared/push.ts';

const CORS = {
  'Access-Control-Allow-Origin': 'https://hub.liquidandlarder.com.au',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SUMMARY_TO = ['kimmy@liquidandlarder.com.au', 'reservations@liquidandlarder.com.au'];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const fmtAud = (cents: number) =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);

async function sendEmail(subject: string, text: string): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Liquid & Larder Pre-auth <no-reply@liquidandlarder.com.au>',
        to: SUMMARY_TO,
        subject,
        text,
      }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  // Fail closed: no CRON_SECRET configured means nobody gets in.
  const expected = Deno.env.get('CRON_SECRET');
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return json({ error: 'Unauthorised' }, 401);
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = body?.dry_run === true;
  } catch (_) { /* empty body is fine */ }

  const today = sydneyToday();
  const placed: string[] = [];
  const failed: string[] = [];
  const attention: string[] = [];
  const pushReminders: string[] = [];
  let linksExpired = 0;
  let pushSent = 0;
  let pushFailed = 0;
  const errors: string[] = [];

  try {
    // ---- 1. Expire stale `sent` links (date of use has passed) ----
    const { data: stale, error: staleErr } = await admin
      .from('preauth_requests')
      .select('id, venue_name, guest_name, booking_date')
      .eq('status', 'sent')
      .lt('booking_date', today);
    if (staleErr) throw new Error(`expiry query: ${staleErr.message}`);

    for (const row of stale ?? []) {
      if (!dryRun) {
        await admin.from('preauth_requests').update({ status: 'expired' }).eq('id', row.id).eq('status', 'sent');
        await admin.from('preauth_audit').insert({
          request_id: row.id,
          event: 'link_expired',
          detail: { booking_date: row.booking_date, expired_on: today },
        });
      }
      linksExpired++;
    }

    // ---- 2. Place holds: card_saved, date of use within 2 days (Sydney) ----
    const { data: due, error: dueErr } = await admin
      .from('preauth_requests')
      .select('*')
      .eq('status', 'card_saved')
      .lte('booking_date', addDays(today, 2))
      .order('booking_date', { ascending: true });
    if (dueErr) throw new Error(`holds query: ${dueErr.message}`);

    for (const row of due ?? []) {
      const days = daysUntil(row.booking_date, today);
      const label = `${row.venue_name} — ${row.guest_name} — ${row.booking_date} — ${fmtAud(row.max_amount_cents)} — ${row.notes ?? ''}`;

      // Too far in the past to hold blind — surface for a human instead.
      if (days < -3) {
        attention.push(`${label} (date of use ${-days} days ago, card saved but never held)`);
        continue;
      }

      if (dryRun) {
        placed.push(`${label} (dry run — would place hold)`);
        continue;
      }

      let result = await placeHold(admin, row);
      if (!result.ok) {
        // One automatic retry after a short pause, against a fresh row.
        await sleep(2000);
        const { data: fresh } = await admin.from('preauth_requests').select('*').eq('id', row.id).maybeSingle();
        if (fresh && fresh.status === 'card_saved') {
          result = await placeHold(admin, fresh);
        }
      }

      if (result.ok) {
        placed.push(label);
      } else {
        await admin.from('preauth_requests').update({ status: 'hold_failed' }).eq('id', row.id).eq('status', 'card_saved');
        await admin.from('preauth_audit').insert({
          request_id: row.id,
          event: 'hold_failed',
          detail: { error: result.error, after_retry: true },
        });
        failed.push(`${label} — ${result.error}`);
      }
    }

    // ---- 3. Push reminders: hold_placed + date of use has passed ---------
    //
    // Superuser recipients only for now — a per-user notifications panel is
    // planned. Stripe holds expire around 7 days after placement, so
    // capturing the day after the date of use is the last comfortable window.
    const { data: reminders, error: remErr } = await admin
      .from('preauth_requests')
      .select('id, venue_name, guest_name, booking_date, max_amount_cents, notes')
      .eq('status', 'hold_placed')
      .lt('booking_date', today)
      .order('booking_date', { ascending: true });
    if (remErr) throw new Error(`reminders query: ${remErr.message}`);

    if (reminders && reminders.length) {
      // Grab every subscription belonging to a superuser in one query.
      const { data: supers, error: supErr } = await admin
        .from('portal_profiles')
        .select('id')
        .eq('is_super_admin', true)
        .eq('active', true);
      if (supErr) throw new Error(`superusers query: ${supErr.message}`);
      const superIds = (supers ?? []).map((s: any) => s.id);

      let subs: PushSubscription[] = [];
      if (superIds.length) {
        const { data: subRows, error: subErr } = await admin
          .from('push_subscriptions')
          .select('id, endpoint, p256dh, auth')
          .in('user_id', superIds);
        if (subErr) throw new Error(`subs query: ${subErr.message}`);
        subs = (subRows ?? []) as PushSubscription[];
      }

      for (const r of reminders) {
        const daysAgo = -daysUntil(r.booking_date, today);
        const label = `${r.venue_name} — ${r.guest_name} — ${fmtAud(r.max_amount_cents)}`;
        pushReminders.push(`${label} (date of use ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`);

        if (dryRun || !subs.length) continue;

        const payload = {
          title: `Charge outstanding — ${r.venue_name}`,
          body: `${r.guest_name} · up to ${fmtAud(r.max_amount_cents)}${r.notes ? ` · ${r.notes}` : ''}`,
          tag: `preauth-capture-${r.id}`, // collapse duplicates if run twice
          url: 'https://hub.liquidandlarder.com.au/preauth/',
          requestId: r.id,
        };
        const out = await sendToSubs(admin, subs, payload);
        pushSent += out.sent;
        pushFailed += out.failed;
      }
    }
  } catch (e) {
    errors.push((e as Error).message);
  }

  // ---- 4 & 5. Summary email, then heartbeat ----
  const ok = errors.length === 0;
  const subjectFlag = failed.length > 0 || attention.length > 0 || !ok ? '[ACTION NEEDED] ' : '';
  const subject = `${subjectFlag}Pre-auth daily run: ${placed.length} hold${placed.length === 1 ? '' : 's'} placed, ${failed.length} failed, ${linksExpired} link${linksExpired === 1 ? '' : 's'} expired, ${pushReminders.length} capture reminder${pushReminders.length === 1 ? '' : 's'}`;

  const lines: string[] = [
    `Pre-authorisation daily run — ${today} (Sydney)${dryRun ? ' — DRY RUN' : ''}`,
    '',
    `Holds placed: ${placed.length}`,
    ...placed.map((l) => `  • ${l}`),
    '',
    `Holds FAILED (after retry): ${failed.length}`,
    ...failed.map((l) => `  • ${l}`),
    '',
    `Links expired: ${linksExpired}`,
    '',
    `Capture reminders sent as push: ${pushReminders.length} reminder${pushReminders.length === 1 ? '' : 's'} (${pushSent} push${pushSent === 1 ? '' : 'es'} delivered, ${pushFailed} failed)`,
    ...pushReminders.map((l) => `  • ${l}`),
  ];
  if (attention.length) {
    lines.push('', 'Needs attention (card saved, date of use well past, no hold placed):', ...attention.map((l) => `  • ${l}`));
  }
  if (errors.length) {
    lines.push('', 'RUN ERRORS:', ...errors.map((l) => `  • ${l}`));
  }
  lines.push('', 'Dashboard: https://hub.liquidandlarder.com.au/preauth/');

  let emailSent = false;
  if (!dryRun) {
    emailSent = await sendEmail(subject, lines.join('\n'));
    try {
      await admin.from('preauth_cron_runs').insert({
        ok,
        holds_placed: placed.length,
        holds_failed: failed.length,
        links_expired: linksExpired,
        email_sent: emailSent,
        detail: { placed, failed, attention, errors, today, pushReminders, pushSent, pushFailed },
      });
    } catch (_) { /* heartbeat best-effort */ }
  }

  return json({
    ok,
    dry_run: dryRun,
    today,
    holds_placed: placed.length,
    holds_failed: failed.length,
    links_expired: linksExpired,
    email_sent: emailSent,
    push_reminders: pushReminders.length,
    push_sent: pushSent,
    push_failed: pushFailed,
    placed,
    failed,
    attention,
    push_reminders_detail: pushReminders,
    errors,
  });
});
