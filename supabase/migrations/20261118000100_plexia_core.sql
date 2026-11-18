create extension if not exists pgcrypto with schema extensions;

create or replace function public.generate_plexia_code()
returns text
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  result text := '';
  i integer;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, floor(random() * length(alphabet))::integer + 1, 1);
  end loop;
  return result;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('teacher', 'student')),
  display_name text check (display_name is null or char_length(display_name) between 1 and 24),
  created_at timestamptz not null default now()
);

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  is_student boolean := coalesce(new.is_anonymous, false) or new.raw_user_meta_data ->> 'account_type' = 'student';
  supplied_name text := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
begin
  insert into public.profiles (user_id, role, display_name)
  values (new.id, case when is_student then 'student' else 'teacher' end, left(supplied_name, 24))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_plexia_profile on auth.users;
create trigger on_auth_user_created_plexia_profile
after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'Profile role is managed by the PLEXIA authentication flow';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_profile_role_change_trigger on public.profiles;
create trigger prevent_profile_role_change_trigger
before update on public.profiles
for each row execute function public.prevent_profile_role_change();

create table if not exists public.presentations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '',
  data jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists presentations_owner_updated_idx on public.presentations (owner_id, updated_at desc);

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  presentation_id uuid not null references public.presentations(id) on delete cascade,
  join_code text not null unique default public.generate_plexia_code() check (join_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'),
  status text not null default 'live' check (status in ('live', 'paused', 'ended')),
  current_slide_index integer not null default 0 check (current_slide_index >= 0),
  activity_status text not null default 'idle' check (activity_status in ('idle', 'running', 'paused', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists class_sessions_owner_created_idx on public.class_sessions (owner_id, created_at desc);

create table if not exists public.session_participants (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table if not exists public.student_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  slide_id uuid not null,
  participant_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  answer_text text not null default '' check (char_length(answer_text) <= 8000),
  answer_json jsonb not null default '{}'::jsonb,
  media_path text,
  score numeric(6,2) check (score is null or score >= 0),
  feedback text,
  ai_evaluation jsonb,
  reviewed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, slide_id, participant_id)
);

create index if not exists student_responses_session_created_idx on public.student_responses (session_id, created_at);
create index if not exists student_responses_session_slide_idx on public.student_responses (session_id, slide_id);

create table if not exists public.user_ai_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_key text not null,
  iv text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.is_plexia_teacher()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select coalesce((select p.role = 'teacher' from public.profiles p where p.user_id = auth.uid()), false);
$$;

create or replace function public.is_plexia_student()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select coalesce((select p.role = 'student' from public.profiles p where p.user_id = auth.uid()), false);
$$;

create or replace function public.is_session_participant(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.session_participants p
    where p.session_id = target_session and p.user_id = auth.uid()
  );
$$;

create or replace function public.is_session_owner(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.class_sessions s
    where s.id = target_session and s.owner_id = auth.uid()
  );
$$;

create or replace function public.is_joined_presentation(target_presentation uuid)
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
      and p.user_id = auth.uid()
      and s.status <> 'ended'
  );
$$;

create or replace function public.student_join_classroom(p_join_code text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  found_session public.class_sessions%rowtype;
  found_presentation public.presentations%rowtype;
  clean_nickname text := left(trim(coalesce(p_nickname, '')), 24);
begin
  if auth.uid() is null or not public.is_plexia_student() then
    raise exception 'Student anonymous authentication required' using errcode = '42501';
  end if;
  if char_length(clean_nickname) < 1 then
    raise exception 'Enter a nickname between 1 and 24 characters' using errcode = '22023';
  end if;
  select * into found_session
  from public.class_sessions s
  where s.join_code = upper(trim(coalesce(p_join_code, '')))
    and s.status <> 'ended'
  limit 1;
  if found_session.id is null then
    raise exception 'Class code not found or session has ended' using errcode = 'P0002';
  end if;
  select * into found_presentation from public.presentations p where p.id = found_session.presentation_id;
  if found_presentation.id is null then
    raise exception 'Presentation is unavailable' using errcode = 'P0002';
  end if;
  insert into public.session_participants (session_id, user_id, nickname)
  values (found_session.id, auth.uid(), clean_nickname)
  on conflict (session_id, user_id)
  do update set nickname = excluded.nickname, last_seen_at = now();

  return jsonb_build_object(
    'session_id', found_session.id,
    'session', jsonb_build_object(
      'id', found_session.id,
      'presentation_id', found_session.presentation_id,
      'join_code', found_session.join_code,
      'status', found_session.status,
      'current_slide_index', found_session.current_slide_index,
      'activity_status', found_session.activity_status,
      'created_at', found_session.created_at
    ),
    'presentation', found_presentation.data - 'ownerId'
  );
end;
$$;

revoke all on function public.student_join_classroom(text, text) from public, anon;
grant execute on function public.student_join_classroom(text, text) to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_presentations_updated_at on public.presentations;
create trigger touch_presentations_updated_at before update on public.presentations
for each row execute function public.touch_updated_at();
drop trigger if exists touch_class_sessions_updated_at on public.class_sessions;
create trigger touch_class_sessions_updated_at before update on public.class_sessions
for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.presentations enable row level security;
alter table public.class_sessions enable row level security;
alter table public.session_participants enable row level security;
alter table public.student_responses enable row level security;
alter table public.user_ai_settings enable row level security;

create policy "Users read their own profile" on public.profiles
for select to authenticated using (user_id = auth.uid());
create policy "Users update their own profile display name" on public.profiles
for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Teachers manage their own presentations" on public.presentations
for all to authenticated
using (owner_id = auth.uid() and public.is_plexia_teacher())
with check (owner_id = auth.uid() and public.is_plexia_teacher());
create policy "Joined students read the active presentation" on public.presentations
for select to authenticated using (public.is_joined_presentation(id));

create policy "Teachers manage their own sessions" on public.class_sessions
for all to authenticated
using (owner_id = auth.uid() and public.is_plexia_teacher())
with check (owner_id = auth.uid() and public.is_plexia_teacher());
create policy "Joined students read their class session" on public.class_sessions
for select to authenticated using (public.is_session_participant(id));

create policy "Teachers read participants for owned sessions" on public.session_participants
for select to authenticated using (public.is_session_owner(session_id) and public.is_plexia_teacher());
create policy "Participants read their own membership" on public.session_participants
for select to authenticated using (user_id = auth.uid() and public.is_plexia_student());

create policy "Students submit one response per slide" on public.student_responses
for insert to authenticated
with check (
  participant_id = auth.uid()
  and public.is_plexia_student()
  and public.is_session_participant(session_id)
);
create policy "Students and teachers read permitted responses" on public.student_responses
for select to authenticated
using (
  (participant_id = auth.uid() and public.is_plexia_student())
  or (public.is_session_owner(session_id) and public.is_plexia_teacher())
);
create policy "Teachers review responses for owned sessions" on public.student_responses
for update to authenticated
using (public.is_session_owner(session_id) and public.is_plexia_teacher())
with check (public.is_session_owner(session_id) and public.is_plexia_teacher());

revoke all on public.user_ai_settings from anon, authenticated;
grant all on public.user_ai_settings to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('presentation-media', 'presentation-media', false, 52428800, array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm']),
  ('student-uploads', 'student-uploads', false, 12582912, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Teachers upload their presentation media" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'presentation-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
  and public.is_plexia_teacher()
);
create policy "Teachers read their presentation media" on storage.objects
for select to authenticated
using (
  bucket_id = 'presentation-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_plexia_teacher()
);
create policy "Participants read media from their active presentation" on storage.objects
for select to authenticated
using (
  bucket_id = 'presentation-media'
  and public.is_plexia_student()
  and exists (
    select 1
    from public.class_sessions s
    join public.presentations p on p.id = s.presentation_id
    where s.presentation_id::text = (storage.foldername(name))[2]
      and p.owner_id::text = (storage.foldername(name))[1]
      and s.status <> 'ended'
      and public.is_session_participant(s.id)
  )
);
create policy "Teachers update their presentation media" on storage.objects
for update to authenticated
using (
  bucket_id = 'presentation-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_plexia_teacher()
)
with check (
  bucket_id = 'presentation-media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.is_plexia_teacher()
);
create policy "Students upload session photos" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'student-uploads'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and (storage.foldername(name))[2] = auth.uid()::text
  and public.is_plexia_student()
  and public.is_session_participant(((storage.foldername(name))[1])::uuid)
);
create policy "Students and session teachers read session photos" on storage.objects
for select to authenticated
using (
  bucket_id = 'student-uploads'
  and (
    ((storage.foldername(name))[2] = auth.uid()::text and public.is_plexia_student())
    or (public.is_session_owner(((storage.foldername(name))[1])::uuid) and public.is_plexia_teacher())
  )
);

alter table public.class_sessions replica identity full;
alter table public.student_responses replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'class_sessions'
  ) then
    alter publication supabase_realtime add table public.class_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'student_responses'
  ) then
    alter publication supabase_realtime add table public.student_responses;
  end if;
end
$$;
