-- Web push subscriptions for the staff dashboard.
--
-- One row per (user, browser install). The device-side subscription is uniquely
-- identified by its endpoint URL; a user re-enabling notifications on the same
-- browser upserts on that unique key. p256dh + auth are the Web Push
-- encryption keys the browser produced when it subscribed — the server needs
-- both to encrypt payloads and cannot recover them if lost.

create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_error   text
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Users manage only their own subscriptions from the browser. The edge
-- functions that send notifications use the service role and bypass RLS.
drop policy if exists "own subs: select" on public.push_subscriptions;
create policy "own subs: select" on public.push_subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists "own subs: insert" on public.push_subscriptions;
create policy "own subs: insert" on public.push_subscriptions
  for insert with check (auth.uid() = user_id);

drop policy if exists "own subs: update" on public.push_subscriptions;
create policy "own subs: update" on public.push_subscriptions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subs: delete" on public.push_subscriptions;
create policy "own subs: delete" on public.push_subscriptions
  for delete using (auth.uid() = user_id);

comment on table public.push_subscriptions is
  'Web Push subscriptions per (user, browser install). Encrypted push payloads '
  'are sent to endpoint using p256dh + auth (RFC 8291, aes128gcm).';
