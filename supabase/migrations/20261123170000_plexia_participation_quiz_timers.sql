-- Additive PLEXIA functionality. Apply through the normal migration process only.
-- Private schemas must not be exposed by PostgREST. No production data is used here.
-- This migration must run as a single transaction. Serialize the legacy-data
-- audit, snapshot backfill, and installation of the write guards with writers.
lock table public.presentations, public.teacher_quiz_keys, public.class_sessions,
  public.student_responses in share row exclusive mode;

-- Reject, never silently strip, private fields at ANY object/array depth. Include
-- the legacy aliases already recognized by the importer's safety filter.
create or replace function plexia_private.presentation_has_private_fields(doc jsonb)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  with recursive nodes(value) as (
    select doc
    union all
    select child.value from nodes n
    cross join lateral (
      select value from jsonb_each(case when jsonb_typeof(n.value) = 'object' then n.value else '{}'::jsonb end)
      union all
      select value from jsonb_array_elements(case when jsonb_typeof(n.value) = 'array' then n.value else '[]'::jsonb end)
    ) child
  )
  select exists(select 1 from nodes where jsonb_typeof(value) = 'object' and value ?| array[
    'correctIndex','correct_index','correctIndices','correct_indices',
    'correctAnswer','correct_answer','correctAnswers','correct_answers',
    'isCorrect','is_correct','answerKey','answer_key','explanation'
  ]);
$$;
revoke all on function plexia_private.presentation_has_private_fields(jsonb) from public, anon, authenticated, service_role;

-- Fail closed without changing a byte of any legacy presentation. Do not include
-- private contents or IDs in the error; remedy and re-run the whole migration.
do $$ begin
  if exists (select 1 from public.presentations p where plexia_private.presentation_has_private_fields(p.data)) then
    raise exception 'Unsafe legacy presentation JSON contains private quiz fields; migration aborted without modifying data. Move private fields to teacher_quiz_keys before retrying.' using errcode = '23514';
  end if;
end $$;
create or replace function plexia_private.guard_private_presentation_fields()
returns trigger language plpgsql security definer set search_path = pg_catalog, plexia_private as $$
begin
  if plexia_private.presentation_has_private_fields(new.data) then
    raise exception 'Presentation JSON must not contain private quiz keys or explanations at any depth; store them in teacher_quiz_keys.' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function plexia_private.guard_private_presentation_fields() from public, anon, authenticated, service_role;
create trigger plexia_guard_private_presentation_fields before insert or update on public.presentations
for each row execute function plexia_private.guard_private_presentation_fields();

-- A minimal server time source for timer skew estimation. The role grant and
-- UID check exclude unauthenticated callers; clock_timestamp is not transaction time.
create or replace function public.plexia_server_time()
returns timestamptz language plpgsql volatile security invoker set search_path = pg_catalog, auth as $$
begin
  if auth.uid() is null then raise exception 'Not authorized' using errcode = '42501'; end if;
  return clock_timestamp();
end $$;
revoke all on function public.plexia_server_time() from public, anon, service_role;
grant execute on function public.plexia_server_time() to authenticated;

alter table public.teacher_quiz_keys add column if not exists correct_indices integer[];
alter table public.session_participants add column if not exists avatar text;
alter table public.class_sessions add column if not exists activity_deadline timestamptz;
-- Remaining time is server-owned, in milliseconds; null denotes no limit.
alter table public.class_sessions add column if not exists activity_remaining_ms bigint;

-- Detect which columns a writer actually supplied, including a same-value
-- legacy correct_index upsert (comparing OLD/NEW alone cannot detect it).
-- Clear transaction-local flags at statement entry as well as after every row:
-- an earlier statement, a zero-row update, or a pre-existing custom setting
-- must not affect the next write. PostgreSQL fires same-kind triggers by name.
create or replace function plexia_private.reset_quiz_key_write_marks()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  perform set_config('plexia.quiz_index_written', '', true);
  perform set_config('plexia.quiz_indices_written', '', true);
  return null;
end $$;
revoke all on function plexia_private.reset_quiz_key_write_marks() from public, anon, authenticated;
create trigger plexia_reset_quiz_key_write_marks before insert or update on public.teacher_quiz_keys
for each statement execute function plexia_private.reset_quiz_key_write_marks();

create or replace function plexia_private.mark_quiz_key_write()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  perform set_config('plexia.' || tg_argv[0], '1', true);
  return new;
end $$;
revoke all on function plexia_private.mark_quiz_key_write() from public, anon, authenticated;
create trigger plexia_mark_quiz_index before update of correct_index on public.teacher_quiz_keys
for each row execute function plexia_private.mark_quiz_key_write('quiz_index_written');
create trigger plexia_mark_quiz_indices before update of correct_indices on public.teacher_quiz_keys
for each row execute function plexia_private.mark_quiz_key_write('quiz_indices_written');

create or replace function plexia_private.sync_quiz_key_indices()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  -- Old writers only update correct_index. Clear a stale new array in that case.
  if tg_op = 'UPDATE' then
    if current_setting('plexia.quiz_index_written', true) = '1'
       and coalesce(current_setting('plexia.quiz_indices_written', true), '') <> '1' then
      new.correct_indices := null;
    end if;
    perform set_config('plexia.quiz_index_written', '', true);
    perform set_config('plexia.quiz_indices_written', '', true);
  end if;
  if new.correct_indices is not null and cardinality(new.correct_indices) > 0 then
    if array_ndims(new.correct_indices) <> 1 or array_lower(new.correct_indices, 1) <> 1
       or exists (select 1 from unnest(new.correct_indices) x where x is null or x < 0)
       or (select count(*) <> count(distinct x) from unnest(new.correct_indices) x) then
      raise exception 'Invalid quiz key indices' using errcode = '22023';
    end if;
    new.correct_index := new.correct_indices[1];
  end if;
  return new;
end $$;
revoke all on function plexia_private.sync_quiz_key_indices() from public, anon, authenticated;
create trigger plexia_sync_quiz_key_indices before insert or update on public.teacher_quiz_keys
for each row execute function plexia_private.sync_quiz_key_indices();

-- The trigger computes all timer values. Client-supplied deadlines/remainders are ignored.
create or replace function plexia_private.manage_activity_timer()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, plexia_private as $$
declare
  duration_json jsonb;
  duration_text text;
  remaining bigint;
  old_running boolean := false;
  new_running boolean;
  new_slide boolean;
  ts timestamptz := clock_timestamp();
begin
  new_slide := tg_op = 'INSERT' or new.current_slide_index is distinct from old.current_slide_index
    or new.presentation_id is distinct from old.presentation_id
    or (tg_op = 'UPDATE' and old.activity_deadline is null and old.activity_remaining_ms is null);
  new_running := new.status = 'live' and new.activity_status = 'running';
  if tg_op = 'UPDATE' then
    old_running := old.status = 'live' and old.activity_status = 'running';
    new.activity_deadline := old.activity_deadline;
    new.activity_remaining_ms := old.activity_remaining_ms;
  else
    new.activity_deadline := null;
    new.activity_remaining_ms := null;
  end if;
  if new.status = 'ended' then
    new.activity_deadline := null;
    new.activity_remaining_ms := null;
  elsif new_slide then
    select p.data -> 'slides' -> new.current_slide_index -> 'content' -> 'timeLimitSeconds'
      into duration_json from public.presentations p where p.id = new.presentation_id;
    if duration_json is null or duration_json = 'null'::jsonb then
      remaining := null;
    else
      duration_text := duration_json #>> '{}';
      if jsonb_typeof(duration_json) <> 'number' or duration_text !~ '^[1-9][0-9]{0,4}$'
          or duration_text::integer > 86400 then
        raise exception 'Invalid activity time limit (expected 1..86400 seconds)' using errcode = '22023';
      end if;
      remaining := duration_text::bigint * 1000;
    end if;
    if new.activity_status = 'ended' and remaining is not null then remaining := 0; end if;
    new.activity_remaining_ms := remaining;
    new.activity_deadline := case when new_running and remaining is not null
      then ts + remaining * interval '1 millisecond' else null end;
  elsif old_running and not new_running then
    if old.activity_deadline is not null then
      new.activity_remaining_ms := greatest(0, ceil(extract(epoch from (old.activity_deadline - ts)) * 1000)::bigint);
    end if;
    if new.activity_status = 'ended' and new.activity_remaining_ms is not null then
      new.activity_remaining_ms := 0;
    end if;
    new.activity_deadline := null;
  elsif not old_running and new_running then
    new.activity_deadline := case when old.activity_remaining_ms is not null
      then ts + old.activity_remaining_ms * interval '1 millisecond' else null end;
  end if;
  return new;
end $$;
revoke all on function plexia_private.manage_activity_timer() from public, anon, authenticated;
create trigger plexia_manage_activity_timer before insert or update on public.class_sessions
for each row execute function plexia_private.manage_activity_timer();

-- Start configured timers on currently active sessions at migration time.
-- Previously there was no authoritative deadline to preserve.
update public.class_sessions set activity_status = activity_status where status <> 'ended';

-- Snapshots keep one private key/options set per session/slide. Later key edits
-- cannot retroactively rewrite a ranking, or make students see different keys.
create table plexia_private.session_quiz_material (
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  slide_id uuid not null,
  -- NULL/missing/invalid material is frozen too: adding a key after the first
  -- response would otherwise change the meaning of that response.
  slide_type jsonb,
  options jsonb,
  allow_multiple jsonb,
  question jsonb,
  correct_indices integer[],
  primary key (session_id, slide_id)
);
create table plexia_private.quiz_grades (
  response_id uuid primary key references public.student_responses(id) on delete cascade,
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  is_correct boolean not null,
  graded_at timestamptz not null default clock_timestamp()
);
create index quiz_grades_session_idx on plexia_private.quiz_grades(session_id, response_id);
alter table plexia_private.session_quiz_material enable row level security;
alter table plexia_private.quiz_grades enable row level security;
revoke all on plexia_private.session_quiz_material, plexia_private.quiz_grades from public, anon, authenticated, service_role;

-- A write (not just a row lock) is essential: at REPEATABLE READ a transaction
-- with an older snapshot must abort rather than miss a newly committed freeze.
create table plexia_private.quiz_material_versions (
  presentation_id uuid primary key references public.presentations(id) on delete cascade,
  version bigint not null default 0
);
revoke all on plexia_private.quiz_material_versions from public, anon, authenticated, service_role;
create or replace function plexia_private.bump_quiz_material_version(p_presentation uuid)
returns void language sql security definer set search_path = pg_catalog, plexia_private as $$
  insert into plexia_private.quiz_material_versions as v (presentation_id, version) values (p_presentation, 1)
  on conflict (presentation_id) do update set version = v.version + 1;
$$;
revoke all on function plexia_private.bump_quiz_material_version(uuid) from public, anon, authenticated, service_role;

-- Fail fast rather than wait while a row trigger already owns a presentation,
-- key or session tuple. A waiting advisory lock here would invert tuple lock
-- order on cascades and create deadlocks. Callers can retry SQLSTATE 40001.
-- Every material/session writer uses the same per-presentation transaction lock.
create or replace function plexia_private.lock_quiz_material(p_presentation uuid)
returns void language plpgsql security definer set search_path = pg_catalog as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended(p_presentation::text, 87912653)) then
    raise exception 'Quizmaterial wird gerade gleichzeitig geändert; bitte den Vorgang erneut versuchen.' using errcode = '40001';
  end if;
end $$;
revoke all on function plexia_private.lock_quiz_material(uuid) from public, anon, authenticated, service_role;


-- Backfill all sessions with pre-migration responses using the only
-- material still available at migration time. Earlier, already-lost historical
-- values cannot be reconstructed; no existing presentation or key is modified.
insert into plexia_private.session_quiz_material
  (session_id, slide_id, slide_type, options, allow_multiple, question, correct_indices)
select distinct on (s.id, r.slide_id) s.id, r.slide_id, slide -> 'type',
  slide -> 'content' -> 'options', slide -> 'content' -> 'allowMultiple',
  slide -> 'content' -> 'question', coalesce(k.correct_indices, array[k.correct_index])
from public.student_responses r
join public.class_sessions s on s.id = r.session_id
join public.presentations p on p.id = s.presentation_id
cross join lateral jsonb_array_elements(case when jsonb_typeof(p.data -> 'slides') = 'array'
  then p.data -> 'slides' else '[]'::jsonb end) with ordinality as slides(slide, ord)
left join public.teacher_quiz_keys k on k.presentation_id = s.presentation_id
  and k.slide_id = r.slide_id and k.owner_id = s.owner_id
where slide ->> 'id' = r.slide_id::text and slide ->> 'type' = 'multiple_choice'
order by s.id, r.slide_id, slides.ord;

-- Serialize capture with material writes before reading the presentation;
-- take the advisory try-lock before the session row lock to avoid response /
-- session-cascade lock inversion. The version write detects stale RR snapshots.
create or replace function plexia_private.capture_quiz_material(p_session uuid, p_slide uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, plexia_private as $$
declare pres uuid; locked_pres uuid; owner uuid; doc jsonb; slide jsonb; indices integer[];
begin
  -- A response tuple can already be locked by its UPDATE or grading RPC.
  -- Never wait for a session DELETE that owns the session row and is waiting
  -- to cascade to that response: try the material lock before FOR SHARE.
  select s.presentation_id into locked_pres from public.class_sessions s where s.id=p_session;
  if not found then return; end if;
  perform plexia_private.lock_quiz_material(locked_pres);
  select s.presentation_id, s.owner_id into pres, owner from public.class_sessions s
    where s.id = p_session for share;
  if not found then return; end if;
  if pres is distinct from locked_pres then
    raise exception 'Die Sitzung wurde gleichzeitig geändert; bitte erneut versuchen.' using errcode='40001';
  end if;
  select p.data into doc from public.presentations p where p.id = pres for update;
  if not found then return; end if;
  perform plexia_private.bump_quiz_material_version(pres);
  if exists(select 1 from plexia_private.session_quiz_material m where m.session_id=p_session and m.slide_id=p_slide) then return; end if;
  select e into slide from jsonb_array_elements(case when jsonb_typeof(doc -> 'slides') = 'array'
    then doc -> 'slides' else '[]'::jsonb end) e
    where e ->> 'id' = p_slide::text and e ->> 'type' = 'multiple_choice' limit 1;
  if slide is null then return; end if;
  select coalesce(k.correct_indices, array[k.correct_index]) into indices
    from public.teacher_quiz_keys k where k.presentation_id=pres and k.slide_id=p_slide and k.owner_id=owner;
  insert into plexia_private.session_quiz_material
    (session_id, slide_id, slide_type, options, allow_multiple, question, correct_indices)
    values (p_session, p_slide, slide -> 'type', slide -> 'content' -> 'options',
      slide -> 'content' -> 'allowMultiple', slide -> 'content' -> 'question', indices)
    on conflict do nothing;
end $$;
revoke all on function plexia_private.capture_quiz_material(uuid,uuid) from public, anon, authenticated, service_role;

-- Keep the old per-ID projection for legacy snapshots. For active sessions the
-- complete ordered set of MC slides is protected, including slides not answered
-- yet, newly added/converted slides and the position of an existing MC slide.
-- Presence flags distinguish a missing property from JSON null.
create or replace function plexia_private.protected_slide_projection(doc jsonb, slide_id uuid)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_array(
    e ? 'type', e -> 'type',
    coalesce((e -> 'content') ? 'options', false), e -> 'content' -> 'options',
    coalesce((e -> 'content') ? 'allowMultiple', false), e -> 'content' -> 'allowMultiple',
    coalesce((e -> 'content') ? 'question', false), e -> 'content' -> 'question') order by ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(doc -> 'slides') = 'array' then doc -> 'slides' else '[]'::jsonb end)
    with ordinality as slides(e, ord) where e ->> 'id' = slide_id::text;
$$;
revoke all on function plexia_private.protected_slide_projection(jsonb,uuid) from public, anon, authenticated, service_role;
create or replace function plexia_private.protected_mc_projection(doc jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_array(
    ord, e ? 'id', e -> 'id', e ? 'type', e -> 'type',
    coalesce((e -> 'content') ? 'options', false), e -> 'content' -> 'options',
    coalesce((e -> 'content') ? 'allowMultiple', false), e -> 'content' -> 'allowMultiple',
    coalesce((e -> 'content') ? 'question', false), e -> 'content' -> 'question') order by ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(doc -> 'slides') = 'array' then doc -> 'slides' else '[]'::jsonb end)
    with ordinality as slides(e, ord) where e ->> 'type' = 'multiple_choice';
$$;
revoke all on function plexia_private.protected_mc_projection(jsonb) from public, anon, authenticated, service_role;
create or replace function plexia_private.guard_snapshotted_presentation()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, plexia_private as $$
declare frozen record; active boolean;
begin
  if tg_op = 'UPDATE' and new.data is not distinct from old.data then return new; end if;
  perform plexia_private.lock_quiz_material(old.id);
  perform plexia_private.bump_quiz_material_version(old.id);
  select exists(select 1 from public.class_sessions s where s.presentation_id=old.id and s.status <> 'ended') into active;
  if active and ((tg_op = 'DELETE' and plexia_private.protected_mc_projection(old.data) <> '[]'::jsonb)
     or (tg_op = 'UPDATE' and plexia_private.protected_mc_projection(old.data)
       is distinct from plexia_private.protected_mc_projection(new.data))) then
    raise exception 'Multiple-Choice-Folien sind ab Sitzungsstart gesperrt. Bitte zuerst alle zugehörigen Sitzungen beenden, bevor Frage, Optionen, Reihenfolge, Auswahlmodus oder Typ geändert oder Folien gelöscht werden.' using errcode = '55000';
  end if;
  -- Preserve the historical snapshot guard, including legacy unusual material.
  for frozen in select distinct m.slide_id from plexia_private.session_quiz_material m
    join public.class_sessions s on s.id=m.session_id
    where s.presentation_id=old.id and s.status <> 'ended'
  loop
    if tg_op = 'DELETE' or plexia_private.protected_slide_projection(old.data, frozen.slide_id)
      is distinct from plexia_private.protected_slide_projection(new.data, frozen.slide_id) then
      raise exception 'Diese Quizfolie ist während einer laufenden oder pausierten Sitzung gesperrt. Bitte zuerst alle zugehörigen Sitzungen beenden.' using errcode = '55000';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function plexia_private.guard_snapshotted_presentation() from public, anon, authenticated, service_role;
create trigger plexia_guard_snapshotted_presentation before update or delete on public.presentations
for each row execute function plexia_private.guard_snapshotted_presentation();

-- A key is protected when its slide is currently MC in any active session, or
-- when an existing active-session snapshot already protected that slide.
create or replace function plexia_private.quiz_key_is_frozen(p_pres uuid, p_slide uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, plexia_private as $$
  select exists (
    select 1 from public.class_sessions s join public.presentations p on p.id=s.presentation_id
    where s.presentation_id=p_pres and s.status <> 'ended' and (
      exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p.data -> 'slides')='array'
        then p.data -> 'slides' else '[]'::jsonb end) e
        where e ->> 'id'=p_slide::text and e ->> 'type'='multiple_choice')
      or exists(select 1 from plexia_private.session_quiz_material m where m.session_id=s.id and m.slide_id=p_slide)
    )
  );
$$;
revoke all on function plexia_private.quiz_key_is_frozen(uuid,uuid) from public, anon, authenticated, service_role;

create or replace function plexia_private.guard_snapshotted_key()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, plexia_private as $$
declare is_frozen boolean; dest_frozen boolean; existing_key boolean := false;
begin
  -- Row locks may already be held. Never wait for a conflicting material
  -- writer; deterministic ordering plus try-lock handles moves and cascades.
  perform plexia_private.lock_quiz_material(x.id) from
    (select distinct id from (values
      (case when tg_op <> 'INSERT' then old.presentation_id else new.presentation_id end),
      (case when tg_op <> 'DELETE' then new.presentation_id else old.presentation_id end)) v(id)
      order by id) x;
  -- Parent deletion owns this same advisory lock; avoid a dangling FK during cascade.
  if tg_op = 'DELETE' and not exists(select 1 from public.presentations p where p.id=old.presentation_id) then return old; end if;
  if tg_op <> 'INSERT' then perform plexia_private.bump_quiz_material_version(old.presentation_id); end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.presentation_id is distinct from old.presentation_id) then
    perform plexia_private.bump_quiz_material_version(new.presentation_id);
  end if;
  if tg_op <> 'INSERT' then
    select plexia_private.quiz_key_is_frozen(old.presentation_id, old.slide_id) into is_frozen;
    if is_frozen and (tg_op = 'DELETE' or new.presentation_id is distinct from old.presentation_id
      or new.slide_id is distinct from old.slide_id or new.owner_id is distinct from old.owner_id
      or new.correct_index is distinct from old.correct_index or new.correct_indices is distinct from old.correct_indices) then
      raise exception 'Der Lösungsschlüssel ist ab Sitzungsstart gesperrt. Bitte zuerst alle zugehörigen Sitzungen beenden, bevor er geändert oder gelöscht wird.' using errcode = '55000';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select plexia_private.quiz_key_is_frozen(new.presentation_id, new.slide_id) into dest_frozen;
    -- Before INSERT cannot distinguish an UPSERT from a real INSERT. Allow an
    -- existing key through; its conflict UPDATE is checked after synchronization.
    if tg_op = 'INSERT' then
      select exists(select 1 from public.teacher_quiz_keys k where k.presentation_id=new.presentation_id and k.slide_id=new.slide_id) into existing_key;
    end if;
    if dest_frozen and ((tg_op = 'INSERT' and not existing_key)
      or (tg_op = 'UPDATE' and (new.presentation_id is distinct from old.presentation_id or new.slide_id is distinct from old.slide_id))) then
      raise exception 'Der Lösungsschlüssel ist ab Sitzungsstart gesperrt. Bitte zuerst alle zugehörigen Sitzungen beenden, bevor er hinzugefügt oder verschoben wird.' using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function plexia_private.guard_snapshotted_key() from public, anon, authenticated, service_role;
-- z sorts after plexia_sync_quiz_key_indices: legacy same-value writes can
-- clear correct_indices and must be checked as the resulting semantic change.
create trigger plexia_z_guard_snapshotted_key before insert or update or delete on public.teacher_quiz_keys
for each row execute function plexia_private.guard_snapshotted_key();

-- Session creation, ending, deletion, reopening and identity moves participate
-- in exactly the same serialization protocol as presentation/key edits. The
-- version WRITE forces old REPEATABLE READ snapshots to abort with 40001.
create or replace function plexia_private.guard_snapshotted_session_identity()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, plexia_private as $$
declare old_pres uuid; new_pres uuid; relevant boolean := false;
begin
  if tg_op <> 'INSERT' then old_pres := old.presentation_id; end if;
  if tg_op <> 'DELETE' then new_pres := new.presentation_id; end if;
  if tg_op = 'INSERT' then
    relevant := new.status <> 'ended';
  elsif tg_op = 'DELETE' then
    -- Even an ended session can cascade to responses concurrently graded.
    relevant := true;
  else
    relevant := (old.status = 'ended') is distinct from (new.status = 'ended')
      or new.presentation_id is distinct from old.presentation_id or new.owner_id is distinct from old.owner_id;
  end if;
  if relevant then
    perform plexia_private.lock_quiz_material(x.id) from
      (select distinct id from (values (old_pres), (new_pres)) v(id) where id is not null order by id) x;
    -- ON DELETE CASCADE may already have removed the parent.
    if old_pres is not null and exists(select 1 from public.presentations p where p.id=old_pres) then
      perform plexia_private.bump_quiz_material_version(old_pres);
    end if;
    if new_pres is not null and new_pres is distinct from old_pres then
      perform plexia_private.bump_quiz_material_version(new_pres);
    end if;
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.presentation_id is distinct from old.presentation_id
      or new.owner_id is distinct from old.owner_id) and not exists
      (select 1 from public.presentations p where p.id=new.presentation_id and p.owner_id=new.owner_id) then
    raise exception 'Die Sitzung muss zu einer eigenen Präsentation gehören.' using errcode='42501';
  end if;
  if tg_op = 'UPDATE' and ((old.status = 'ended' and new.status <> 'ended') or
     (old.status <> 'ended' and (new.presentation_id is distinct from old.presentation_id or new.owner_id is distinct from old.owner_id)))
     and exists(select 1 from plexia_private.session_quiz_material m where m.session_id=old.id) then
    if old.status = 'ended' and new.status <> 'ended' then
      raise exception 'A finished session with quiz submissions cannot be reopened; start a new session instead.' using errcode = '55000';
    end if;
    raise exception 'A session with quiz submissions cannot change presentation or owner before it ends.' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function plexia_private.guard_snapshotted_session_identity() from public, anon, authenticated, service_role;
create trigger plexia_guard_snapshotted_session_identity before insert or update or delete on public.class_sessions
for each row execute function plexia_private.guard_snapshotted_session_identity();

-- Lock the session against concurrent navigation/pause while accepting an answer.
-- Existing RLS and review guards remain in force; this adds an independent guard.
create or replace function plexia_private.guard_answer_timing_and_grade()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, plexia_private, auth as $$
declare s record; locked_pres uuid;
begin
  if tg_op = 'UPDATE' then
    if new.answer_text is not distinct from old.answer_text
       and new.answer_json is not distinct from old.answer_json
       and new.media_path is not distinct from old.media_path then return new; end if;
    if exists (select 1 from plexia_private.quiz_grades g where g.response_id = old.id) then
      raise exception 'A graded quiz response cannot be changed' using errcode = '42501';
    end if;
    -- Self-contained even where the earlier reviewed-response migration is absent.
    if public.is_plexia_student() and old.reviewed then
      raise exception 'A reviewed response cannot be changed' using errcode = '42501';
    end if;
  end if;
  if public.is_plexia_student() then
    -- UPDATE already owns the response tuple. A plain MVCC lookup followed by
    -- try-lock avoids waiting on a session DELETE cascading to that tuple.
    select cs.presentation_id into locked_pres from public.class_sessions cs where cs.id=new.session_id;
    if not found then raise exception 'The response is not editable now or its deadline has passed' using errcode='42501'; end if;
    perform plexia_private.lock_quiz_material(locked_pres);
    select cs.status, cs.activity_status, cs.activity_deadline, cs.presentation_id, cs.current_slide_index
      into s from public.class_sessions cs where cs.id = new.session_id for share;
    if s.presentation_id is distinct from locked_pres then
      raise exception 'Die Sitzung wurde gleichzeitig geändert; bitte erneut versuchen.' using errcode='40001';
    end if;
    perform p.id from public.presentations p where p.id=s.presentation_id for update;
    if s.status is distinct from 'live' or s.activity_status is distinct from 'running'
       or (select p.data -> 'slides' -> s.current_slide_index ->> 'id' from public.presentations p where p.id=s.presentation_id) is distinct from new.slide_id::text
       or (s.activity_deadline is not null and clock_timestamp() >= s.activity_deadline) then
      raise exception 'The response is not editable now or its deadline has passed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function plexia_private.guard_answer_timing_and_grade() from public, anon, authenticated;
create trigger plexia_guard_answer_timing_and_grade before insert or update on public.student_responses
for each row execute function plexia_private.guard_answer_timing_and_grade();

-- Internal only; NULL means there is no valid key/answer yet, never a hint.
-- Both old string choices and unambiguous zero-based choiceIndices are accepted.
create or replace function plexia_private.grade_submitted_response(p_response_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, plexia_private as $$
declare
  r public.student_responses%rowtype;
  slide jsonb; options jsonb; key_indices integer[]; selected integer[] := '{}';
  v jsonb; value_text text; idx integer; matched integer; is_correct boolean;
  material plexia_private.session_quiz_material%rowtype;
begin
  select g.is_correct into is_correct from plexia_private.quiz_grades g where g.response_id = p_response_id;
  if found then return is_correct; end if;
  select * into r from public.student_responses where id = p_response_id;
  if not found then return null; end if;
  -- Freeze even an empty/missing/invalid key at the first submission; this is
  -- deliberately separate from whether a particular answer can be graded.
  perform plexia_private.capture_quiz_material(r.session_id, r.slide_id);
  select m.* into material from plexia_private.session_quiz_material m
    where m.session_id = r.session_id and m.slide_id = r.slide_id;
  if not found then return null; end if;
  options := material.options;
  key_indices := material.correct_indices;
  if material.slide_type is distinct from '"multiple_choice"'::jsonb
      or key_indices is null or cardinality(key_indices) = 0
      or jsonb_typeof(options) is distinct from 'array' then return null; end if;
  if jsonb_array_length(options) = 0
      or exists (select 1 from jsonb_array_elements(options) e where jsonb_typeof(e) <> 'string')
      or exists (select 1 from unnest(key_indices) i where i is null or i < 0 or i >= jsonb_array_length(options))
      or (select count(*) <> count(distinct i) from unnest(key_indices) i) then return null; end if;
  if jsonb_typeof(r.answer_json -> 'choiceIndices') = 'array' then
    for v in select * from jsonb_array_elements(r.answer_json -> 'choiceIndices') loop
      value_text := v #>> '{}';
      if jsonb_typeof(v) <> 'number' or value_text !~ '^(0|[1-9][0-9]{0,8})$' then return null; end if;
      idx := value_text::integer;
      if idx >= jsonb_array_length(options) or idx = any(selected) then return null; end if;
      selected := array_append(selected, idx);
    end loop;
  elsif jsonb_typeof(r.answer_json -> 'choices') = 'array' then
    for v in select * from jsonb_array_elements(r.answer_json -> 'choices') loop
      if jsonb_typeof(v) <> 'string' then return null; end if;
      select count(*), min((o.ordinality - 1)::integer) into matched, idx
        from jsonb_array_elements(options) with ordinality o(item, ordinality) where o.item = v;
      if matched <> 1 or idx = any(selected) then return null; end if;
      selected := array_append(selected, idx);
    end loop;
  else return null;
  end if;
  if cardinality(selected) = 0 then return null; end if;
  -- Exact set equality, not subset/contains; order does not matter.
  select array_agg(i order by i) into selected from unnest(selected) i;
  select array_agg(i order by i) into key_indices from unnest(material.correct_indices) i;
  is_correct := selected = key_indices;
  insert into plexia_private.quiz_grades(response_id, session_id, is_correct)
    values (r.id, r.session_id, is_correct) on conflict (response_id) do nothing;
  select g.is_correct into is_correct from plexia_private.quiz_grades g where g.response_id = r.id;
  return is_correct;
end $$;
revoke all on function plexia_private.grade_submitted_response(uuid) from public, anon, authenticated, service_role;

-- Grade at submission, so ranking does not depend on whether a client asks for feedback.
create or replace function plexia_private.grade_new_response()
returns trigger language plpgsql security definer
set search_path = pg_catalog, plexia_private as $$
begin
  perform plexia_private.grade_submitted_response(new.id);
  return new;
end $$;
revoke all on function plexia_private.grade_new_response() from public, anon, authenticated;
create trigger plexia_grade_new_response after insert on public.student_responses
for each row execute function plexia_private.grade_new_response();
create trigger plexia_grade_corrected_response after update of answer_text, answer_json, media_path on public.student_responses
for each row execute function plexia_private.grade_new_response();

create or replace function public.grade_my_quiz_response(p_session_id uuid, p_slide_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, plexia_private, auth as $$
declare response_id uuid; result boolean;
begin
  if auth.uid() is null or not public.is_plexia_student() or not public.is_session_participant(p_session_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select r.id into response_id from public.student_responses r
    where r.session_id = p_session_id and r.slide_id = p_slide_id and r.participant_id = auth.uid()
    for update;
  if response_id is null then raise exception 'Quiz response unavailable' using errcode = 'P0002'; end if;
  result := plexia_private.grade_submitted_response(response_id);
  if result is null then raise exception 'Quiz response unavailable' using errcode = 'P0002'; end if;
  return jsonb_build_object('is_correct', result);
end $$;
revoke all on function public.grade_my_quiz_response(uuid, uuid) from public, anon;
grant execute on function public.grade_my_quiz_response(uuid, uuid) to authenticated;

create or replace function public.get_session_ranking(p_session_id uuid)
returns table(nickname text, avatar text, correct_count bigint)
language plpgsql security definer set search_path = pg_catalog, public, plexia_private, auth as $$
declare permitted boolean; candidate record;
begin
  if auth.uid() is null then raise exception 'Not authorized' using errcode = '42501'; end if;
  select ((s.owner_id = auth.uid() and public.is_plexia_teacher()) or
    (public.is_plexia_student() and public.is_session_participant(s.id)
      and p.data -> 'slides' -> s.current_slide_index ->> 'type' = 'results'))
    into permitted from public.class_sessions s join public.presentations p on p.id = s.presentation_id
    where s.id = p_session_id;
  if not coalesce(permitted, false) then raise exception 'Not authorized' using errcode = '42501'; end if;
  -- Reconcile old or previously keyless valid submissions without trusting clients.
  for candidate in select r.id from public.student_responses r
    where r.session_id = p_session_id and not exists
      (select 1 from plexia_private.quiz_grades g where g.response_id = r.id)
    order by r.id for update of r
  loop
    perform plexia_private.grade_submitted_response(candidate.id);
  end loop;
  return query select sp.nickname, sp.avatar, count(g.response_id) filter (where g.is_correct)
    from public.session_participants sp
    left join public.student_responses r on r.session_id = sp.session_id and r.participant_id = sp.user_id
    left join plexia_private.quiz_grades g on g.response_id = r.id and g.session_id = sp.session_id
    where sp.session_id = p_session_id
    group by sp.user_id, sp.nickname, sp.avatar
    order by count(g.response_id) filter (where g.is_correct) desc, sp.nickname asc, sp.user_id asc;
end $$;
revoke all on function public.get_session_ranking(uuid) from public, anon;
grant execute on function public.get_session_ranking(uuid) to authenticated;

-- Only the supported avatar identifiers (or NULL to clear) are permitted.
create or replace function public.set_my_session_avatar(p_session_id uuid, p_avatar text)
returns void language plpgsql security definer set search_path = pg_catalog, public, auth as $$
begin
  if auth.uid() is null or not public.is_plexia_student() or not public.is_session_participant(p_session_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_avatar is not null and not (p_avatar = any (array['fox','panda','frog','koala','octopus','lion','penguin','bee']::text[])) then
    raise exception 'Invalid avatar identifier' using errcode = '22023';
  end if;
  update public.session_participants sp set avatar = p_avatar
    from public.class_sessions s join public.presentations p on p.id = s.presentation_id
    where sp.session_id = p_session_id and sp.user_id = auth.uid() and s.id = sp.session_id
      and s.status <> 'ended' and (p_avatar is null or p.data #>> '{participation,avatarsEnabled}' = 'true');
  if not found then raise exception 'Avatar unavailable' using errcode = '42501'; end if;
end $$;
revoke all on function public.set_my_session_avatar(uuid, text) from public, anon;
grant execute on function public.set_my_session_avatar(uuid, text) to authenticated;

-- Share the existing five-attempt/minute budget with actual join attempts.
-- Successful and expected-failure results return normally so counters commit.
-- An IP/gateway rate limit is still needed against identities created in bulk.
create or replace function public.get_join_options(p_join_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, auth as $$
declare
  attempts integer;
  current_window timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / 60) * 60);
  generic_failure constant text := 'Der Zugangscode ist ungültig oder die Stunde ist nicht verfügbar. Bitte prüfe den Code bei deiner Lehrkraft.';
  opts jsonb;
begin
  if auth.uid() is null then return jsonb_build_object('error', generic_failure); end if;
  insert into public.student_join_attempt_limits as limits(user_id, window_started_at, attempt_count)
    values (auth.uid(), current_window, 1)
    on conflict (user_id) do update set window_started_at = excluded.window_started_at,
      attempt_count = case when limits.window_started_at = excluded.window_started_at then limits.attempt_count + 1 else 1 end
    returning attempt_count into attempts;
  if attempts > 5 or not public.is_plexia_student()
      or upper(trim(coalesce(p_join_code, ''))) !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$' then
    return jsonb_build_object('error', generic_failure);
  end if;
  select p.data -> 'participation' into opts from public.class_sessions s
    join public.presentations p on p.id = s.presentation_id
    where s.join_code = upper(trim(p_join_code)) and s.status <> 'ended';
  if not found then return jsonb_build_object('error', generic_failure); end if;
  return jsonb_build_object('avatars_enabled', coalesce(opts -> 'avatarsEnabled' = 'true'::jsonb, false),
    'nickname_generator_enabled', coalesce(opts -> 'nicknameGeneratorEnabled' = 'true'::jsonb, false));
end $$;
revoke all on function public.get_join_options(text) from public, anon;
grant execute on function public.get_join_options(text) to authenticated;

-- Atomic quiz publish protocol. Raw presentation/key writes are drafts only;
-- a session may start only after this owner-authorized RPC publishes both rows.
create table if not exists plexia_private.quiz_publish_state (
  presentation_id uuid primary key references public.presentations(id) on delete cascade,
  dirty boolean not null default true,
  published_at timestamptz not null default clock_timestamp()
);
revoke all on plexia_private.quiz_publish_state from public, anon, authenticated, service_role;

create or replace function plexia_private.mark_presentation_publish_dirty()
returns trigger language plpgsql security definer set search_path = pg_catalog, plexia_private as $$
begin
  if coalesce(current_setting('plexia.publish_in_progress', true), '') <> '1' then
    insert into plexia_private.quiz_publish_state(presentation_id, dirty) values (new.id, true)
      on conflict (presentation_id) do update set dirty = true;
  end if;
  return new;
end $$;
revoke all on function plexia_private.mark_presentation_publish_dirty() from public, anon, authenticated, service_role;
create trigger plexia_mark_publish_dirty_presentation after update on public.presentations
for each row execute function plexia_private.mark_presentation_publish_dirty();

create or replace function plexia_private.mark_key_publish_dirty()
returns trigger language plpgsql security definer set search_path = pg_catalog, plexia_private as $$
begin
  -- During owner/user cleanup, a cascading key delete can run after its
  -- presentation has already been removed. Do not create an orphan state row;
  -- ordinary inserts/updates/deletes still mark an existing presentation dirty.
  if coalesce(current_setting('plexia.publish_in_progress', true), '') <> '1'
     and exists(select 1 from public.presentations p where p.id = case when tg_op='DELETE' then old.presentation_id else new.presentation_id end) then
    insert into plexia_private.quiz_publish_state(presentation_id, dirty) values (case when tg_op='DELETE' then old.presentation_id else new.presentation_id end, true)
      on conflict (presentation_id) do update set dirty = true;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
revoke all on function plexia_private.mark_key_publish_dirty() from public, anon, authenticated, service_role;
create trigger plexia_mark_publish_dirty_key after insert or update or delete on public.teacher_quiz_keys
for each row execute function plexia_private.mark_key_publish_dirty();

-- Existing rows represent the last known saved state at migration time. New
-- writes become drafts and must be published through the RPC below.
insert into plexia_private.quiz_publish_state(presentation_id, dirty)
select id, false from public.presentations
on conflict (presentation_id) do nothing;

create or replace function public.publish_presentation_with_quiz_keys(p_presentation jsonb, p_keys jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public, plexia_private, auth as $$
declare uid uuid := auth.uid(); pid uuid; item jsonb; active_sessions boolean; current_data jsonb;
begin
  if uid is null or not public.is_plexia_teacher() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if jsonb_typeof(p_presentation) <> 'object' or jsonb_typeof(p_keys) <> 'array' then raise exception 'Invalid publish payload' using errcode = '22023'; end if;
  pid := nullif(p_presentation->>'id','')::uuid;
  if pid is null then raise exception 'Invalid presentation id' using errcode = '22023'; end if;
  perform plexia_private.lock_quiz_material(pid);
  select exists(select 1 from public.class_sessions s where s.presentation_id=pid and s.status in ('live','paused')) into active_sessions;
  if exists(select 1 from public.presentations p where p.id=pid and p.owner_id<>uid) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if (select count(*) from jsonb_array_elements(p_keys)) <>
     (select count(distinct value->>'slideId') from jsonb_array_elements(p_keys)) then
    raise exception 'Duplicate quiz key slide id' using errcode = '22023';
  end if;
  if active_sessions then
    select p.data into current_data from public.presentations p where p.id=pid and p.owner_id=uid for update;
    if current_data is null or plexia_private.protected_mc_projection(current_data)
       is distinct from plexia_private.protected_mc_projection(p_presentation) then
      raise exception 'Multiple-Choice-Folien sind ab Sitzungsstart gesperrt.' using errcode = '55000';
    end if;
    -- Results and other non-quiz content may still be shared while a session is
    -- live. The private key set itself must remain byte-for-byte equivalent;
    -- do not delete/reinsert frozen rows, even when their values are unchanged.
    if exists (
      select 1 from (
        select k.slide_id, k.correct_index, k.correct_indices, k.explanation
        from public.teacher_quiz_keys k where k.presentation_id=pid and k.owner_id=uid
      ) stored
      full join (
        select (value->>'slideId')::uuid as slide_id,
          coalesce((value->>'correctIndex')::integer, (value->'correctIndices'->>0)::integer) as correct_index,
          case when jsonb_typeof(value->'correctIndices')='array'
            then array(select jsonb_array_elements_text(value->'correctIndices')::integer) else null end as correct_indices,
          coalesce(value->>'explanation','') as explanation
        from jsonb_array_elements(p_keys)
      ) incoming using (slide_id)
      where stored.slide_id is null or incoming.slide_id is null
        or stored.correct_index is distinct from incoming.correct_index
        or stored.correct_indices is distinct from incoming.correct_indices
        or stored.explanation is distinct from incoming.explanation
    ) then
      raise exception 'Der Lösungsschlüssel ist ab Sitzungsstart gesperrt.' using errcode = '55000';
    end if;
  end if;
  perform set_config('plexia.publish_in_progress','1',true);
  insert into public.presentations(id, owner_id, title, description, data, updated_at)
    values(pid, uid, coalesce(p_presentation->>'title',''), coalesce(p_presentation->>'description',''), p_presentation, clock_timestamp())
    on conflict (id) do update set title=excluded.title, description=excluded.description, data=excluded.data, updated_at=excluded.updated_at
      where public.presentations.owner_id=uid;
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not active_sessions then
    delete from public.teacher_quiz_keys where presentation_id=pid and owner_id=uid;
    for item in select value from jsonb_array_elements(p_keys) loop
      if jsonb_typeof(item) <> 'object' or nullif(item->>'slideId','') is null then raise exception 'Invalid quiz key' using errcode = '22023'; end if;
      insert into public.teacher_quiz_keys(presentation_id, slide_id, owner_id, correct_index, correct_indices, explanation)
      values(pid, (item->>'slideId')::uuid, uid,
        coalesce((item->>'correctIndex')::integer, (item->'correctIndices'->>0)::integer),
        case when jsonb_typeof(item->'correctIndices')='array' then array(select jsonb_array_elements_text(item->'correctIndices')::integer) else null end,
        coalesce(item->>'explanation',''));
    end loop;
  end if;
  insert into plexia_private.quiz_publish_state(presentation_id,dirty,published_at) values(pid,false,clock_timestamp())
    on conflict (presentation_id) do update set dirty=false,published_at=excluded.published_at;
end $$;
revoke all on function public.publish_presentation_with_quiz_keys(jsonb,jsonb) from public, anon;
grant execute on function public.publish_presentation_with_quiz_keys(jsonb,jsonb) to authenticated;

create or replace function plexia_private.guard_unpublished_session()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, plexia_private as $$
begin
  if not exists(select 1 from plexia_private.quiz_publish_state st where st.presentation_id=new.presentation_id and st.dirty=false) then
    raise exception 'Quizänderungen wurden noch nicht atomar veröffentlicht. Bitte speichern und erneut starten.' using errcode='55000';
  end if;
  return new;
end $$;
revoke all on function plexia_private.guard_unpublished_session() from public, anon, authenticated, service_role;
create trigger plexia_guard_unpublished_session before insert on public.class_sessions
for each row execute function plexia_private.guard_unpublished_session();
