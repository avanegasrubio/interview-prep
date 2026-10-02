-- Multiple clients: each client has their own job list and their own background for outreach messages.
-- Applied once in the Supabase SQL editor. No personal data lives in this file.

-- 1. Per-client profile, used by the connection notes, emails and follow-ups.
alter table public.members
  add column if not exists background text,   -- one short sentence, e.g. "I support APIs on Google Cloud at Acme" (connection notes, 200-character limit)
  add column if not exists bio text,          -- a short paragraph for emails
  add column if not exists target_role text,  -- what they are looking for, used when a contact has no matching job
  add column if not exists signature text;    -- full name used to sign emails

-- 2. Jobs belong to one client. NULL means unassigned (only the admin sees it, e.g. a new match waiting to be vetted).
alter table public.jobs add column if not exists client_email text;
create index if not exists jobs_client_email_idx on public.jobs (lower(client_email));

drop policy if exists "members read jobs" on public.jobs;
create policy "members read their jobs" on public.jobs for select using (
  private.is_admin()
  or (private.is_member() and (
    lower(client_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or created_by = auth.uid()))
);

-- 3. The admin manages clients (members rows). Members can still only read their own row.
drop policy if exists "admin manages members" on public.members;
create policy "admin manages members" on public.members for all
  using (private.is_admin()) with check (private.is_admin());

-- 4. The admin's client list now carries the profile fields.
drop function if exists public.member_accounts();
create function public.member_accounts()
returns table(user_id uuid, email text, role text, display_name text, gmail_address text, gmail_connected boolean,
              gmail_last_sync timestamptz, gmail_drafts boolean,
              background text, bio text, target_role text, signature text, signed_up boolean)
language sql stable security definer set search_path to 'public' as $$
  select u.id, m.email, m.role, m.display_name, g.gmail_address, g.user_id is not null, g.last_sync_at,
         coalesce(g.scopes like '%gmail.compose%', false),
         m.background, m.bio, m.target_role, m.signature, u.id is not null
  from public.members m
  left join auth.users u on lower(u.email) = lower(m.email)
  left join public.gmail_tokens g on g.user_id = u.id
  where private.is_admin();
$$;
