// Push subscription management for the staff dashboard.
//
// Authenticated (verify_jwt=true). The browser calls this to:
//   GET             → { publicKey, subscribed: boolean }
//   POST { endpoint, keys: { p256dh, auth } } → upsert my subscription
//   DELETE { endpoint }                        → remove my subscription
//
// RLS on push_subscriptions restricts rows to the authenticated user, so we
// use a per-request client bound to their JWT rather than the service role.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': 'https://hub.liquidandlarder.com.au',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'Unauthorised' }, 401);

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) return json({ error: 'Unauthorised' }, 401);

  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';

  try {
    if (req.method === 'GET') {
      const { count } = await sb
        .from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id);
      return json({ publicKey, subscribed: (count ?? 0) > 0 });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const endpoint: string = body?.endpoint;
      const p256dh: string = body?.keys?.p256dh;
      const authKey: string = body?.keys?.auth;
      if (!endpoint || !p256dh || !authKey) {
        return json({ error: 'endpoint, keys.p256dh and keys.auth are required' }, 400);
      }
      const ua = req.headers.get('User-Agent')?.slice(0, 300) ?? null;
      const { error } = await sb.from('push_subscriptions').upsert({
        user_id: user.id,
        endpoint,
        p256dh,
        auth: authKey,
        user_agent: ua,
        last_seen_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: 'endpoint' });
      if (error) throw new Error(error.message);
      return json({ ok: true, publicKey });
    }

    if (req.method === 'DELETE') {
      let endpoint: string | undefined;
      try { endpoint = (await req.json())?.endpoint; } catch (_) { /* body optional */ }
      const q = sb.from('push_subscriptions').delete().eq('user_id', user.id);
      const { error } = endpoint ? await q.eq('endpoint', endpoint) : await q;
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
