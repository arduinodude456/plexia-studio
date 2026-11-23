-- Disposable local DB only: run the before test, then the migration, then this file.
\set ON_ERROR_STOP on
do $$ declare n integer; begin
  select count(*) into n from public.class_sessions where id::text like '77777777-7777-4777-8777-77777777777%' and status='live' and activity_status='running' and activity_deadline is not null and activity_remaining_ms=30000;
  if n<>3 then raise exception 'legacy live sessions/timers changed: %',n; end if;
  if (select count(*) from plexia_private.session_quiz_material where session_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc') and options='["A","B"]'::jsonb and correct_indices='{0}')<>2 then
    raise exception 'historical snapshots not preserved'; end if;
  if exists(select 1 from plexia_private.session_quiz_material where session_id::text like '77777777-7777-4777-8777-77777777777%') then
    raise exception 'unexpected snapshot for unanswered sessions'; end if;
  begin update public.teacher_quiz_keys set correct_index=1 where presentation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'legacy live session did not lock key'; exception when object_not_in_prerequisite_state then null; end;
  begin update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'legacy live session did not lock options'; exception when object_not_in_prerequisite_state then null; end;
end $$;
update public.class_sessions set status='ended' where presentation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update public.teacher_quiz_keys set correct_index=1 where presentation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
do $$ begin
  if (select count(*) from plexia_private.session_quiz_material where session_id in ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc') and options='["A","B"]'::jsonb and correct_indices='{0}')<>2 then
    raise exception 'editing after end rewrote historical snapshots'; end if;
end $$;
\echo 'Three legacy live sessions/timers and both historical snapshots preserved; edits released only after end.'
