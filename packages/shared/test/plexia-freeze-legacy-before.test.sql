-- Disposable local DB only. Run AFTER earlier migrations and BEFORE
-- 20261123170000_plexia_participation_quiz_timers.sql, as a superuser.
-- Then run that migration as one transaction and run
-- plexia-freeze-legacy-after.test.sql against the same disposable DB.
\set ON_ERROR_STOP on
insert into auth.users(id,is_anonymous,raw_user_meta_data) values
 ('11111111-1111-4111-8111-111111111111',false,'{}'),
 ('22222222-2222-4222-8222-222222222222',true,'{}');
insert into public.presentations(id,owner_id,title,data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Legacy safe',
 '{"slides":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1","type":"multiple_choice","content":{"question":"Old?","options":["A","B"],"allowMultiple":false,"timeLimitSeconds":30}}]}'::jsonb);
insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','11111111-1111-4111-8111-111111111111',0);
insert into public.class_sessions(id,owner_id,presentation_id,join_code,status,activity_status,current_slide_index) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ABC234','paused','paused',0),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','BCD234','ended','ended',0),
 ('77777777-7777-4777-8777-777777777771','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','XYZ234','live','running',0),
 ('77777777-7777-4777-8777-777777777772','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','XYZ235','live','running',0),
 ('77777777-7777-4777-8777-777777777773','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','XYZ236','live','running',0);
insert into public.session_participants(session_id,user_id,nickname) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','Alice'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','22222222-2222-4222-8222-222222222222','Alice');
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','22222222-2222-4222-8222-222222222222','Alice','{"choices":["A"]}'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','22222222-2222-4222-8222-222222222222','Alice','{"choices":["A"]}');
