-- Application answer bank: one row per member, answers stored as jsonb {items:[{q,a}]}.
-- Members read and edit their own; the admin can read and edit everyone's.
create table if not exists public.answers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"items":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.answers enable row level security;
drop policy if exists "own answers" on public.answers;
create policy "own answers" on public.answers for all
  using (user_id = auth.uid() and private.is_member())
  with check (user_id = auth.uid() and private.is_member());
drop policy if exists "admin answers" on public.answers;
create policy "admin answers" on public.answers for all
  using (private.is_admin()) with check (private.is_admin());

-- Daily email: a Google Apps Script in the admin's Gmail asks daily-email for each
-- member's list and sends it. The script proves itself with this vault secret.
-- The secret itself is created once, outside this file, with
--   select vault.create_secret(<random hex>, 'mail_script_secret');
-- and pasted into the Apps Script. It is never committed.
create or replace function public.check_mail_secret(s text) returns boolean
  language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'mail_script_secret' and decrypted_secret = s);
$$;
revoke all on function public.check_mail_secret(text) from public, anon, authenticated;
grant execute on function public.check_mail_secret(text) to service_role;
