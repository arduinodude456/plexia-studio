create schema if not exists plexia_private;
revoke all on schema plexia_private from public, anon, authenticated, service_role;

grant usage on schema plexia_private to postgres;

create table if not exists plexia_private.encryption_secrets (
  secret_name text primary key,
  secret_value text not null,
  created_at timestamptz not null default now()
);

alter table plexia_private.encryption_secrets enable row level security;
revoke all on plexia_private.encryption_secrets from public, anon, authenticated, service_role;

insert into plexia_private.encryption_secrets (secret_name, secret_value)
values ('groq-aes-256-gcm', encode(extensions.gen_random_bytes(32), 'base64'))
on conflict (secret_name) do nothing;

create or replace function public.get_plexia_groq_encryption_key()
returns text
language plpgsql
security definer
set search_path = pg_catalog, plexia_private, auth
as $$
declare
  stored_key text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  select secret_value into stored_key
  from plexia_private.encryption_secrets
  where secret_name = 'groq-aes-256-gcm';
  if stored_key is null then
    raise exception 'Groq encryption key is unavailable';
  end if;
  return stored_key;
end;
$$;

revoke all on function public.get_plexia_groq_encryption_key() from public, anon, authenticated;
grant execute on function public.get_plexia_groq_encryption_key() to service_role;
