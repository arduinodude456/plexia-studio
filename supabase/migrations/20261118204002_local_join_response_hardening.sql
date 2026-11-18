-- Local-only additive hardening. Apply remotely later through the project's migration process.

-- 32-symbol alphabet; reducing a cryptographic byte modulo 32 is unbiased.
create or replace function public.generate_plexia_code()
returns text
language plpgsql
volatile
set search_path = pg_catalog, extensions
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  random_bytes bytea := extensions.gen_random_bytes(6);
  result text := '';
  i integer;
begin
  for i in 0..5 loop
    result := result || substr(alphabet, (get_byte(random_bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

revoke all on function public.generate_plexia_code() from public, anon;
grant execute on function public.generate_plexia_code() to authenticated;

-- One fixed UTC minute bucket per authenticated user. The upsert is atomic under concurrency.
create table if not exists public.student_join_attempt_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0)
);
alter table public.student_join_attempt_limits enable row level security;
revoke all on public.student_join_attempt_limits from public, anon, authenticated;

create or replace function public.student_join_classroom(p_join_code text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
declare
  found_session public.class_sessions%rowtype;
  found_presentation public.presentations%rowtype;
  clean_nickname text := left(trim(coalesce(p_nickname, '')), 24);
  current_window timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60);
  attempts integer;
  generic_failure constant text := 'Der Zugangscode ist ungültig oder die Stunde ist nicht verfügbar. Bitte prüfe den Code bei deiner Lehrkraft.';
begin
  if auth.uid() is null then
    return jsonb_build_object('error', generic_failure);
  end if;

  insert into public.student_join_attempt_limits as limits (user_id, window_started_at, attempt_count)
  values (auth.uid(), current_window, 1)
  on conflict (user_id) do update
  set window_started_at = excluded.window_started_at,
      attempt_count = case
        when limits.window_started_at = excluded.window_started_at then limits.attempt_count + 1
        else 1
      end
  returning attempt_count into attempts;

  -- All expected failures below return normally, so the consumed attempt is committed.
  if attempts > 5 then
    return jsonb_build_object('error', generic_failure);
  end if;

  begin
    if not public.is_plexia_student() then
      return jsonb_build_object('error', generic_failure);
    end if;
    if char_length(clean_nickname) < 1 then
      return jsonb_build_object('error', 'Bitte wähle einen Nickname zwischen 1 und 24 Zeichen.');
    end if;
    if upper(trim(coalesce(p_join_code, ''))) !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$' then
      return jsonb_build_object('error', generic_failure);
    end if;

    select * into found_session
    from public.class_sessions s
    where s.join_code = upper(trim(coalesce(p_join_code, '')))
      and s.status <> 'ended'
    limit 1;
    if found_session.id is null then
      return jsonb_build_object('error', generic_failure);
    end if;

    select * into found_presentation
    from public.presentations p
    where p.id = found_session.presentation_id;
    if found_presentation.id is null then
      return jsonb_build_object('error', generic_failure);
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
  exception when others then
    -- The inner block rolls back only its own work, not the rate-counter upsert above.
    return jsonb_build_object('error', generic_failure);
  end;
end;
$$;

revoke all on function public.student_join_classroom(text, text) from public, anon;
grant execute on function public.student_join_classroom(text, text) to authenticated;

-- A response can only be inserted for the currently running slide.
drop policy if exists "Students submit one response per slide" on public.student_responses;
create policy "Students submit response on current running slide" on public.student_responses
for insert to authenticated
with check (
  participant_id = (select auth.uid())
  and (select public.is_plexia_student())
  and public.is_session_participant(session_id)
  and score is null
  and feedback is null
  and ai_evaluation is null
  and reviewed is false
  and exists (
    select 1
    from public.session_participants participant
    where participant.session_id = student_responses.session_id
      and participant.user_id = (select auth.uid())
      and participant.nickname = student_responses.nickname
  )
  and (
    media_path is null
    or media_path like (student_responses.session_id::text || '/' || (select auth.uid())::text || '/%')
  )
  and exists (
    select 1
    from public.class_sessions session
    join public.presentations presentation on presentation.id = session.presentation_id
    where session.id = student_responses.session_id
      and session.status = 'live'
      and session.activity_status = 'running'
      and presentation.data -> 'slides' -> session.current_slide_index ->> 'id' = student_responses.slide_id::text
  )
);

create policy "Students correct response on current running slide" on public.student_responses
for update to authenticated
using (
  participant_id = (select auth.uid())
  and (select public.is_plexia_student())
  and public.is_session_participant(session_id)
  and exists (
    select 1
    from public.class_sessions session
    join public.presentations presentation on presentation.id = session.presentation_id
    where session.id = student_responses.session_id
      and session.status = 'live'
      and session.activity_status = 'running'
      and presentation.data -> 'slides' -> session.current_slide_index ->> 'id' = student_responses.slide_id::text
  )
)
with check (
  participant_id = (select auth.uid())
  and (select public.is_plexia_student())
  and public.is_session_participant(session_id)
  and exists (
    select 1
    from public.session_participants participant
    where participant.session_id = student_responses.session_id
      and participant.user_id = (select auth.uid())
      and participant.nickname = student_responses.nickname
  )
  and (
    media_path is null
    or media_path like (student_responses.session_id::text || '/' || (select auth.uid())::text || '/%')
  )
  and exists (
    select 1
    from public.class_sessions session
    join public.presentations presentation on presentation.id = session.presentation_id
    where session.id = student_responses.session_id
      and session.status = 'live'
      and session.activity_status = 'running'
      and presentation.data -> 'slides' -> session.current_slide_index ->> 'id' = student_responses.slide_id::text
  )
);

-- Column grants let students change only answer content/media and teachers change only review fields.
revoke update on public.student_responses from public, anon, authenticated;
grant update (answer_text, answer_json, media_path, score, feedback, ai_evaluation, reviewed)
  on public.student_responses to authenticated;

create or replace function public.guard_student_response_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public, auth
as $$
begin
  if public.is_plexia_student() then
    if new.id is distinct from old.id
      or new.session_id is distinct from old.session_id
      or new.slide_id is distinct from old.slide_id
      or new.participant_id is distinct from old.participant_id
      or new.nickname is distinct from old.nickname
      or new.created_at is distinct from old.created_at
      or new.score is distinct from old.score
      or new.feedback is distinct from old.feedback
      or new.ai_evaluation is distinct from old.ai_evaluation
      or new.reviewed is distinct from old.reviewed then
      raise exception 'Students may only correct their own answer content';
    end if;

    if new.participant_id is distinct from auth.uid()
      or not public.is_session_participant(new.session_id)
      or not exists (
        select 1
        from public.class_sessions session
        join public.presentations presentation on presentation.id = session.presentation_id
        where session.id = new.session_id
          and session.status = 'live'
          and session.activity_status = 'running'
          and presentation.data -> 'slides' -> session.current_slide_index ->> 'id' = new.slide_id::text
      ) then
      raise exception 'The response is not editable now';
    end if;

    if new.media_path is distinct from old.media_path
      and new.media_path is not null
      and new.media_path not like (new.session_id::text || '/' || auth.uid()::text || '/%') then
      raise exception 'Students may only attach their own session media';
    end if;
    return new;
  end if;

  if public.is_plexia_teacher() and public.is_session_owner(old.session_id) then
    return new;
  end if;

  raise exception 'Not authorized to update this response';
end;
$$;

revoke all on function public.guard_student_response_update() from public, anon, authenticated;
create trigger guard_student_response_update_trigger
before update on public.student_responses
for each row execute function public.guard_student_response_update();
