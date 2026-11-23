-- Run only against a disposable Supabase-compatible PostgreSQL database after all migrations.
-- Exercises the actual authenticated RPC transaction; fixtures are rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT: %', message; end if; end $$;
insert into auth.users(id,is_anonymous,raw_user_meta_data) values
 ('51000000-0000-4000-8000-000000000001',false,'{}'),
 ('51000000-0000-4000-8000-000000000002',true,'{}');
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.publish_presentation_with_quiz_keys(
 '{"id":"52000000-0000-4000-8000-000000000001","title":"Atomic draft","description":"","theme":"light","slides":[{"id":"53000000-0000-4000-8000-000000000001","type":"multiple_choice","title":"Question","content":{"question":"Q","options":["A","B"],"allowMultiple":false}},{"id":"53000000-0000-4000-8000-000000000002","type":"results","title":"Results","content":{}}]}'::jsonb,
 '[{"slideId":"53000000-0000-4000-8000-000000000001","correctIndex":1,"correctIndices":[1],"explanation":"B is right"}]'::jsonb
);
reset role;
select pg_temp.assert_true((select dirty=false from plexia_private.quiz_publish_state where presentation_id='52000000-0000-4000-8000-000000000001'), 'RPC marks pair clean only on success');
select pg_temp.assert_true((select data->'slides'->0->'content' ? 'correctIndex' is false from public.presentations where id='52000000-0000-4000-8000-000000000001'), 'public presentation excludes private keys');
select pg_temp.assert_true((select correct_indices='{1}' and explanation='B is right' from public.teacher_quiz_keys where presentation_id='52000000-0000-4000-8000-000000000001'), 'RPC stores private key with presentation');

-- A student identity cannot call the teacher-only publisher.
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$ begin
  begin perform public.publish_presentation_with_quiz_keys(
    '{"id":"52000000-0000-4000-8000-000000000001","title":"No","slides":[]}'::jsonb,'[]'::jsonb);
    raise exception 'unauthorized publish accepted' using errcode='P0001';
  exception when sqlstate '42501' then null; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub','51000000-0000-4000-8000-000000000001',true);

-- A failing key insert happens after the presentation write/delete within the RPC;
-- the statement must roll back the whole presentation+key pair.
set local role authenticated;
do $$ begin
  begin perform public.publish_presentation_with_quiz_keys(
    '{"id":"52000000-0000-4000-8000-000000000001","title":"Must roll back","description":"","theme":"light","slides":[{"id":"53000000-0000-4000-8000-000000000001","type":"multiple_choice","title":"Question","content":{"question":"Q","options":["A","B"],"allowMultiple":false}},{"id":"53000000-0000-4000-8000-000000000002","type":"results","title":"Results","content":{}}]}'::jsonb,
    '[{"slideId":"53000000-0000-4000-8000-000000000001","correctIndices":[],"explanation":"bad"}]'::jsonb);
    raise exception 'invalid key publish unexpectedly succeeded' using errcode='P0001';
  exception when not_null_violation then null; end;
end $$;
reset role;
select pg_temp.assert_true((select title='Atomic draft' from public.presentations where id='52000000-0000-4000-8000-000000000001'), 'failed publisher rolls back presentation update');
select pg_temp.assert_true((select correct_indices='{1}' and explanation='B is right' from public.teacher_quiz_keys where presentation_id='52000000-0000-4000-8000-000000000001'), 'failed publisher rolls back private key replacement');

-- A results-only update may publish during a live session, but its key set and
-- multiple-choice projection remain unchanged and frozen.
insert into public.class_sessions(id,owner_id,presentation_id,join_code,status,activity_status,current_slide_index) values
 ('54000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','ATC234','live','running',0);
set local role authenticated;
select public.publish_presentation_with_quiz_keys(
 '{"id":"52000000-0000-4000-8000-000000000001","title":"Atomic draft","description":"","theme":"light","slides":[{"id":"53000000-0000-4000-8000-000000000001","type":"multiple_choice","title":"Question","content":{"question":"Q","options":["A","B"],"allowMultiple":false}},{"id":"53000000-0000-4000-8000-000000000002","type":"results","title":"Results","content":{"sharedResults":[{"label":"Class","value":1}]}}]}'::jsonb,
 '[{"slideId":"53000000-0000-4000-8000-000000000001","correctIndex":1,"correctIndices":[1],"explanation":"B is right"}]'::jsonb
);
do $$ begin
  begin perform public.publish_presentation_with_quiz_keys(
    '{"id":"52000000-0000-4000-8000-000000000001","title":"Atomic draft","description":"","theme":"light","slides":[{"id":"53000000-0000-4000-8000-000000000001","type":"multiple_choice","title":"Question","content":{"question":"Q","options":["A","B"],"allowMultiple":false}},{"id":"53000000-0000-4000-8000-000000000002","type":"results","title":"Results","content":{"sharedResults":[{"label":"Class","value":1}]}}]}'::jsonb,
    '[{"slideId":"53000000-0000-4000-8000-000000000001","correctIndex":0,"correctIndices":[0],"explanation":"A is right"}]'::jsonb);
    raise exception 'live frozen key publish unexpectedly succeeded' using errcode='P0001';
  exception when sqlstate '55000' then null; end;
end $$;
reset role;
select pg_temp.assert_true((select correct_indices='{1}' and explanation='B is right' from public.teacher_quiz_keys where presentation_id='52000000-0000-4000-8000-000000000001'), 'live publish preserves frozen key');
select pg_temp.assert_true((select data->'slides'->1->'content' ? 'sharedResults' from public.presentations where id='52000000-0000-4000-8000-000000000001'), 'live results-only update succeeds');
rollback;
\echo 'PASS: authenticated atomic publisher, rollback, live sharing and quiz freeze.'
