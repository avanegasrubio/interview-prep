-- Resume queue: the daily job task inserts a row (file name + resume text),
-- and a trigger asks the resume-pdf edge function to turn it into a PDF in
-- the private "resumes" bucket. Run once in the Supabase SQL editor.

create table if not exists public.resume_queue (
  id bigint generated always as identity primary key,
  name text not null
    check (name ~ '^Edwin-Allen_[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*_Resume$' and length(name) <= 150),
  markdown text not null check (length(markdown) between 200 and 30000),
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- No policies on purpose: the app's users (anon/authenticated) cannot read or
-- write this table. Only the database owner and the service role can.
alter table public.resume_queue enable row level security;

create or replace function public.resume_queue_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base text;
  tok text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into tok  from vault.decrypted_secrets where name = 'resume_upload_token';
  if base is null or tok is null then
    update public.resume_queue set status = 'error', error = 'Vault secrets missing' where id = new.id;
    return new;
  end if;
  perform net.http_post(
    url := base || '/functions/v1/resume-pdf',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-resume-token', tok),
    body := jsonb_build_object('id', new.id),
    timeout_milliseconds := 20000
  );
  return new;
end;
$$;

revoke all on function public.resume_queue_notify() from public, anon, authenticated;

drop trigger if exists resume_queue_after_insert on public.resume_queue;
create trigger resume_queue_after_insert
  after insert on public.resume_queue
  for each row execute function public.resume_queue_notify();
