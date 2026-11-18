create table if not exists public.ai_rate_limits (
  owner_id uuid not null references auth.users(id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (owner_id, window_start)
);

alter table public.ai_rate_limits enable row level security;
revoke all on public.ai_rate_limits from public, anon, authenticated;
grant all on public.ai_rate_limits to service_role;

create or replace function public.consume_groq_rate_limit(p_owner_id uuid, p_limit integer default 20)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  current_count integer;
  active_window timestamptz := date_trunc('minute', now());
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  insert into public.ai_rate_limits (owner_id, window_start, request_count)
  values (p_owner_id, active_window, 1)
  on conflict (owner_id, window_start)
  do update set request_count = public.ai_rate_limits.request_count + 1
  returning request_count into current_count;
  return current_count <= greatest(1, least(coalesce(p_limit, 20), 20));
end;
$$;

revoke all on function public.consume_groq_rate_limit(uuid, integer) from public, anon, authenticated;
grant execute on function public.consume_groq_rate_limit(uuid, integer) to service_role;

revoke all on function public.is_plexia_teacher() from public, anon;
revoke all on function public.is_plexia_student() from public, anon;
revoke all on function public.is_session_participant(uuid) from public, anon;
revoke all on function public.is_session_owner(uuid) from public, anon;
revoke all on function public.is_joined_presentation(uuid) from public, anon;
revoke all on function public.generate_plexia_code() from public, anon;
grant execute on function public.is_plexia_teacher() to authenticated, service_role;
grant execute on function public.is_plexia_student() to authenticated, service_role;
grant execute on function public.is_session_participant(uuid) to authenticated, service_role;
grant execute on function public.is_session_owner(uuid) to authenticated, service_role;
grant execute on function public.is_joined_presentation(uuid) to authenticated, service_role;
grant execute on function public.generate_plexia_code() to authenticated, service_role;
