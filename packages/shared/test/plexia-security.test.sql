-- Run only in a disposable Supabase-compatible local test DB after migrations.
-- No production data: all fixtures are rolled back.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT: %', message; end if; end $$;
insert into auth.users(id, is_anonymous, raw_user_meta_data) values
 ('11111111-1111-4111-8111-111111111111',false,'{}'),
 ('22222222-2222-4222-8222-222222222222',true,'{}'),
 ('33333333-3333-4333-8333-333333333333',true,'{}'),
 ('44444444-4444-4444-8444-444444444444',true,'{}');
insert into public.presentations(id,owner_id,title,data) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Test',
 '{"participation":{"avatarsEnabled":true,"nicknameGeneratorEnabled":true},"slides":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1","type":"multiple_choice","content":{"options":["A","B","C"],"allowMultiple":true,"timeLimitSeconds":3}},{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2","type":"results","content":{}},{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3","type":"multiple_choice","content":{"options":["A","B"],"timeLimitSeconds":1}}]}'::jsonb);
insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index,correct_indices) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','11111111-1111-4111-8111-111111111111',0,'{0,2}'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','11111111-1111-4111-8111-111111111111',0,null);
-- Legacy writers may upsert the same correct_index while replacing a multi key.
update public.teacher_quiz_keys set correct_index=0 where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
select pg_temp.assert_true((select correct_indices is null from public.teacher_quiz_keys where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'same-value legacy key clears stale multi key');
update public.teacher_quiz_keys set correct_index=0, correct_indices='{0,2}' where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
update public.teacher_quiz_keys set explanation='clarification' where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
select pg_temp.assert_true((select correct_indices='{0,2}' from public.teacher_quiz_keys where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'multi key survives unrelated update');
-- This local security fixture represents material that has been atomically published.
update plexia_private.quiz_publish_state set dirty=false where presentation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
insert into public.class_sessions(id,owner_id,presentation_id,join_code,status,activity_status,current_slide_index) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ABC234','live','running',0),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','DEF234','live','running',0),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','EFG234','live','running',2);
insert into public.session_participants(session_id,user_id,nickname) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','Alice'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','33333333-3333-4333-8333-333333333333','Bob'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','44444444-4444-4444-8444-444444444444','Carol'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','22222222-2222-4222-8222-222222222222','Alice'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','33333333-3333-4333-8333-333333333333','Bob');
select pg_temp.assert_true((select activity_deadline > clock_timestamp() from public.class_sessions where join_code='ABC234'), 'deadline initialized');

set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.assert_true((select count(*)=0 from public.teacher_quiz_keys), 'student cannot read teacher keys');
select pg_temp.assert_true(public.get_join_options('ABC234') = '{"avatars_enabled":true,"nickname_generator_enabled":true}'::jsonb, 'join options minimal JSON');
do $$ begin
  begin perform public.grade_my_quiz_response('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'); raise exception 'accepted missing submission'; exception when no_data_found then null; end;
  begin perform public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); raise exception 'ranking leaked before results'; exception when insufficient_privilege then null; end;
  begin perform * from plexia_private.quiz_grades; raise exception 'private grades accessible'; exception when insufficient_privilege then null; end;
  begin perform public.set_my_session_avatar('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','https://example.com'); raise exception 'URL avatar allowed'; exception when invalid_parameter_value then null; end;
end $$;
select public.set_my_session_avatar('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fox');
-- A single-index legacy key continues to grade without correct_indices.
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
 values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',auth.uid(),'Alice','{"choices":["A"]}');
select pg_temp.assert_true(public.grade_my_quiz_response('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3') = '{"is_correct":true}'::jsonb, 'legacy single-key fallback');
-- Invalid answer is not graded; the first valid correction is graded and locked.
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
 values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',auth.uid(),'Bob','{"choiceIndices":[]}');
do $$ begin
  begin perform public.grade_my_quiz_response('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'); raise exception 'invalid guess graded'; exception when no_data_found then null; end;
end $$;
update public.student_responses set answer_json='{"choiceIndices":[0]}' where session_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and participant_id=auth.uid();
select pg_temp.assert_true(public.grade_my_quiz_response('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3') = '{"is_correct":true}'::jsonb, 'valid correction automatically graded');
do $$ begin
  begin update public.student_responses set answer_json='{"choiceIndices":[1]}' where session_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and participant_id=auth.uid(); raise exception 'graded correction editable'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
 values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','22222222-2222-4222-8222-222222222222','Alice','{"choices":["C","A"]}');
select pg_temp.assert_true(public.grade_my_quiz_response('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') = '{"is_correct":true}'::jsonb, 'legacy exact multi correct');
do $$ begin
  begin update public.student_responses set answer_json='{"choices":["B"]}' where participant_id=auth.uid(); raise exception 'graded answer editable'; exception when insufficient_privilege then null; end;
  begin update public.student_responses set score=100 where participant_id=auth.uid(); raise exception 'score forgery allowed'; exception when others then if sqlerrm = 'score forgery allowed' then raise; end if; end;
end $$;
-- A reviewed, ungraded response is protected even without migration 20261119082000.
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
 values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',auth.uid(),'Carol','{}');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
update public.student_responses set reviewed=true where session_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
do $$ begin
  begin update public.student_responses set answer_text='tampered' where session_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; raise exception 'reviewed answer editable'; exception when insufficient_privilege then null; end;
end $$;
-- An active session freezes the published key for every participant.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$ begin
  begin update public.teacher_quiz_keys set correct_index=1 where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    raise exception 'active quiz key mutation accepted';
  exception when sqlstate '55000' then null; end;
end $$;
select pg_temp.assert_true((select correct_indices='{0,2}' from public.teacher_quiz_keys where slide_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), 'active session preserves frozen key');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
 values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','33333333-3333-4333-8333-333333333333','Bob','{"choiceIndices":[1]}');
select pg_temp.assert_true(public.grade_my_quiz_response('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') = '{"is_correct":false}'::jsonb, 'exact multi rejects wrong set');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.assert_true((select count(*)=2 from public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')), 'teacher ranking available on quiz slide');
update public.class_sessions set current_slide_index=1 where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select correct_count=1 from public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') where nickname='Alice'), 'teacher sees correct count');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select pg_temp.assert_true((select correct_count=0 from public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') where nickname='Bob'), 'student results ranking wrong count');
select pg_temp.assert_true((select avatar='fox' from public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') where nickname='Alice'), 'avatar visible on results');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
do $$ begin
  begin perform public.get_session_ranking('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'); raise exception 'outsider got ranking'; exception when insufficient_privilege then null; end;
  begin perform public.set_my_session_avatar('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','fox'); raise exception 'outsider set avatar'; exception when insufficient_privilege then null; end;
end $$;
-- Shared budget limits both invalid option probes and joins; errors return normally.
select public.get_join_options('ABC234') from generate_series(1,5);
select pg_temp.assert_true(public.get_join_options('ABC234') ? 'error', 'pre-join options rate limit');
select pg_temp.assert_true(public.student_join_classroom('ABC234','X') ? 'error', 'join shares rate limit');
-- Advance to a one-second slide, pause, resume, and prove late submission is rejected.
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
update public.class_sessions set current_slide_index=2 where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select activity_deadline > clock_timestamp() and activity_deadline < clock_timestamp()+interval '2 seconds' from public.class_sessions where join_code='ABC234'), 'new slide resets timer');
update public.class_sessions set status='paused' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select activity_deadline is null and activity_remaining_ms between 1 and 1000 from public.class_sessions where join_code='ABC234'), 'session pause freezes remaining time');
select pg_sleep(0.1);
update public.class_sessions set status='live' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select activity_deadline > clock_timestamp() and activity_deadline < clock_timestamp()+interval '2 seconds' from public.class_sessions where join_code='ABC234'), 'session resume restores timer');
update public.class_sessions set activity_status='paused' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select activity_deadline is null and activity_remaining_ms between 1 and 1000 from public.class_sessions where join_code='ABC234'), 'pause freezes remaining time');
select pg_sleep(0.1);
update public.class_sessions set activity_status='running', activity_deadline=clock_timestamp()+interval '1 day' where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select pg_temp.assert_true((select activity_deadline < clock_timestamp()+interval '2 seconds' from public.class_sessions where join_code='ABC234'), 'resume uses server remaining not forged deadline');
select pg_sleep(1.1);
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$ begin
  begin insert into public.student_responses(session_id,slide_id,participant_id,nickname,answer_json)
   values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',auth.uid(),'Alice','{"choices":["A"]}'); raise exception 'late answer accepted'; exception when insufficient_privilege then null; end;
end $$;
rollback;
