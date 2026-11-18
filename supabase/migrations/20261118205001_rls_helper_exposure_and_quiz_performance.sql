-- Keep boolean SECURITY DEFINER helpers available to RLS without exposing
-- them as public PostgREST RPCs. Do not add plexia_internal to API-exposed schemas.
create schema if not exists plexia_internal;
revoke all on schema plexia_internal from public, anon, authenticated;
grant usage on schema plexia_internal to authenticated;
comment on schema plexia_internal is
  'Non-API internal RLS helper functions. Keep this schema out of PostgREST exposed schemas.';

create or replace function plexia_internal.is_session_participant(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.session_participants p
    where p.session_id = target_session and p.user_id = (select auth.uid())
  );
$$;

create or replace function plexia_internal.is_session_owner(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.class_sessions s
    where s.id = target_session and s.owner_id = (select auth.uid())
  );
$$;

create or replace function plexia_internal.is_joined_presentation(target_presentation uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1
    from public.class_sessions s
    join public.session_participants p on p.session_id = s.id
    where s.presentation_id = target_presentation
      and p.user_id = (select auth.uid())
      and s.status <> 'ended'
  );
$$;

revoke all on function plexia_internal.is_session_participant(uuid) from public, anon;
revoke all on function plexia_internal.is_session_owner(uuid) from public, anon;
revoke all on function plexia_internal.is_joined_presentation(uuid) from public, anon;
grant execute on function plexia_internal.is_session_participant(uuid) to authenticated;
grant execute on function plexia_internal.is_session_owner(uuid) to authenticated;
grant execute on function plexia_internal.is_joined_presentation(uuid) to authenticated;

create or replace function public.is_session_participant(target_session uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public, auth, plexia_internal
as $$ select plexia_internal.is_session_participant(target_session); $$;

create or replace function public.is_session_owner(target_session uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public, auth, plexia_internal
as $$ select plexia_internal.is_session_owner(target_session); $$;

create or replace function public.is_joined_presentation(target_presentation uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public, auth, plexia_internal
as $$ select plexia_internal.is_joined_presentation(target_presentation); $$;

revoke all on function public.is_session_participant(uuid) from public, anon;
revoke all on function public.is_session_owner(uuid) from public, anon;
revoke all on function public.is_joined_presentation(uuid) from public, anon;
grant execute on function public.is_session_participant(uuid) to authenticated;
grant execute on function public.is_session_owner(uuid) to authenticated;
grant execute on function public.is_joined_presentation(uuid) to authenticated;

-- Evaluate stable identity/role helpers once per statement, not once per row.
drop policy if exists "Teachers manage private answer keys for their presentations" on public.teacher_quiz_keys;
create policy "Teachers manage private answer keys for their presentations"
on public.teacher_quiz_keys
for all to authenticated
using (
  owner_id = (select auth.uid())
  and (select public.is_plexia_teacher())
  and exists (
    select 1 from public.presentations p
    where p.id = teacher_quiz_keys.presentation_id
      and p.owner_id = (select auth.uid())
  )
)
with check (
  owner_id = (select auth.uid())
  and (select public.is_plexia_teacher())
  and exists (
    select 1 from public.presentations p
    where p.id = teacher_quiz_keys.presentation_id
      and p.owner_id = (select auth.uid())
  )
);
