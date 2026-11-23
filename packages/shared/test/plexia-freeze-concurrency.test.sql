-- Disposable LOCAL PostgreSQL only. Run as a local superuser after migrations.
-- dblink opens two independent transactions; no network/service is contacted.
-- The fixture is committed for the independent sessions and removed at the end.
\set ON_ERROR_STOP on
create extension if not exists dblink;
create or replace function pg_temp.assert_code(actual text, expected text, label text)
returns void language plpgsql as $$ begin
  if actual is distinct from expected then
    raise exception 'ASSERT %: expected %, got %', label, expected, actual;
  end if;
  raise notice 'PASS % (%)', label, actual;
end $$;
insert into auth.users(id,is_anonymous,raw_user_meta_data)
 values ('10000000-0000-4000-8000-000000000001',false,'{}');
insert into public.presentations(id,owner_id,title,data) values
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Concurrency',
  '{"slides":[{"id":"30000000-0000-4000-8000-000000000001","type":"multiple_choice","content":{"question":"Q","options":["A","B"],"allowMultiple":false}},{"id":"30000000-0000-4000-8000-000000000002","type":"multiple_choice","content":{"options":["A","B"]}}]}'::jsonb);
insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index) values
 ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',0);
select dblink_connect('a','dbname=' || current_database());
select dblink_connect('b','dbname=' || current_database());
select dblink_connect('c','dbname=' || current_database());
select dblink_exec('c', 'set statement_timeout = ''3s''');
select dblink_exec('c', 'set lock_timeout = ''1s''');
select dblink_exec('a', 'set statement_timeout = ''3s''');
select dblink_exec('b', 'set statement_timeout = ''3s''');
select dblink_exec('a', 'set lock_timeout = ''1s''');
select dblink_exec('b', 'set lock_timeout = ''1s''');
-- Catch errors inside a subtransaction, exposing SQLSTATE to the assertions.
select dblink_exec('a',$q$create function pg_temp.try_sql(cmd text) returns text language plpgsql as $f$
 begin execute cmd; return 'ok'; exception when others then return sqlstate; end $f$$q$);
select dblink_exec('b',$q$create function pg_temp.try_sql(cmd text) returns text language plpgsql as $f$
 begin execute cmd; return 'ok'; exception when others then return sqlstate; end $f$$q$);

-- Start is uncommitted. All three material writes fail fast (40001), not a
-- deadlock or an allowed update from the stale statement snapshot.
select dblink_exec('a','begin');
select dblink_exec('a',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status)
 values ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK234','live')$q$);
select pg_temp.assert_code(code,'40001','uncommitted start versus options') from dblink('b',$q$select pg_temp.try_sql($s$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(code,'40001','uncommitted start versus key update') from dblink('b',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(code,'40001','uncommitted start versus missing key insert') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index) values ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',0)$s$)$q$) t(code text);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'55000','committed start versus options') from dblink('b',$q$select pg_temp.try_sql($s$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(code,'55000','committed start versus key') from dblink('b',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select dblink_exec('a',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000001'$q$);

-- Reverse ordering: uncommitted options update vs start. Retry after commit
-- succeeds and sees the committed presentation, then freezes it.
select dblink_exec('a','begin');
select dblink_exec('a',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='20000000-0000-4000-8000-000000000001'$q$);
select pg_temp.assert_code(code,'40001','uncommitted options versus start') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK235','live')$s$)$q$) t(code text);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'ok','retry start after options commit') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK235','live')$s$)$q$) t(code text);
select dblink_exec('a',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000002'$q$);

-- Key write first, including an absent key insert, versus start.
select dblink_exec('a','begin');
select dblink_exec('a',$q$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001'$q$);
select pg_temp.assert_code(code,'40001','uncommitted key update versus start') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK236','live')$s$)$q$) t(code text);
select dblink_exec('a','commit');
select dblink_exec('a','begin');
select dblink_exec('a',$q$insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index) values ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',0)$q$);
select pg_temp.assert_code(code,'40001','uncommitted key insert versus start') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK236','live')$s$)$q$) t(code text);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'ok','retry start after key commit') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK236','live')$s$)$q$) t(code text);
select dblink_exec('a',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000003'$q$);

-- Parent DELETE would cascade to the key row held by the other writer.
-- The parent guard must fail fast rather than form presentation/key cycles.
select dblink_exec('a','begin');
select dblink_exec('a',$q$update public.teacher_quiz_keys set correct_index=0 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$q$);
select pg_temp.assert_code(code,'40001','key write versus cascading parent delete') from dblink('b',$q$select pg_temp.try_sql($s$delete from public.presentations where id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(code,'40001','simultaneous different key rows') from dblink('b',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000002'$s$)$q$) t(code text);
select dblink_exec('a','commit');

-- An old REPEATABLE READ snapshot cannot start after an option commit.
select dblink_exec('b','begin isolation level repeatable read');
select * from dblink('b',$q$select count(*)::int from public.presentations$q$) t(n int);
select dblink_exec('a',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,question}','"Q2"') where id='20000000-0000-4000-8000-000000000001'$q$);
select pg_temp.assert_code(code,'40001','RR stale start after options') from dblink('b',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK237','live')$s$)$q$) t(code text);
select dblink_exec('b','rollback');
-- An old snapshot cannot edit either options or a key after session creation.
select dblink_exec('b','begin isolation level repeatable read');
select * from dblink('b',$q$select count(*)::int from public.presentations$q$) t(n int);
select dblink_exec('a',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK237','live')$q$);
select pg_temp.assert_code(code,'40001','RR stale options after start') from dblink('b',$q$select pg_temp.try_sql($s$update public.presentations set data=jsonb_set(data,'{slides,0,content,question}','"Q3"') where id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(code,'40001','RR stale key after start') from dblink('b',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=0 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select dblink_exec('b','rollback');
select dblink_exec('a',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000004'$q$);

-- A statement can have started before the session commits and be waiting for
-- an unrelated pre-existing row lock. After it wakes, its guard must use a fresh
-- Read Committed snapshot, not the stale outer statement snapshot.
select dblink_exec('a','begin');
select * from dblink('a',$q$select 1 from public.teacher_quiz_keys where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001' for update$q$) t(n int);
select dblink_send_query('b',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$s$)$q$);
select pg_sleep(0.1);
select pg_temp.assert_code(dblink_is_busy('b')::text,'1','key update is waiting before trigger');
select dblink_exec('c',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK239','live')$q$);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'55000','waiting key sees committed start') from dblink_get_result('b') t(code text);
select * from dblink_get_result('b') t(code text);
select dblink_exec('c',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000006'$q$);
select dblink_exec('a','begin');
select * from dblink('a',$q$select 1 from public.presentations where id='20000000-0000-4000-8000-000000000001' for no key update$q$) t(n int);
select dblink_send_query('b',$q$select pg_temp.try_sql($s$update public.presentations set data=jsonb_set(data,'{slides,0,content,question}','"late"') where id='20000000-0000-4000-8000-000000000001'$s$)$q$);
select pg_sleep(0.1);
select pg_temp.assert_code(dblink_is_busy('b')::text,'1','presentation update is waiting before trigger');
select dblink_exec('c',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK23A','live')$q$);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'55000','waiting presentation sees committed start') from dblink_get_result('b') t(code text);
select * from dblink_get_result('b') t(code text);
select dblink_exec('c',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000007'$q$);

-- Response UPDATE already owns its tuple, while DELETE owns the session tuple
-- and cascades to that response. Test both an active and an ended session.
-- A blocking session FOR SHARE before try-lock would deadlock this exact order.
insert into auth.users(id,is_anonymous,raw_user_meta_data)
 values ('10000000-0000-4000-8000-000000000002',true,'{}');
insert into public.class_sessions(id,owner_id,presentation_id,join_code,status,activity_status) values
 ('40000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK23C','live','running'),
 ('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK23D','live','running');
insert into public.session_participants(session_id,user_id,nickname) values
 ('40000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000002','Student'),
 ('40000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000002','Student');
insert into public.student_responses(id,session_id,slide_id,participant_id,nickname,answer_json) values
 ('50000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Student','{}'),
 ('50000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','Student','{}');
update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000010';
select dblink_exec('a',$q$set request.jwt.claim.sub='10000000-0000-4000-8000-000000000002'$q$);
select pg_temp.assert_code(ok::text,'true','student context for deletion test') from dblink('a',$q$select public.is_plexia_student()$q$) t(ok boolean);
select dblink_exec('a','begin');
select * from dblink('a',$q$select 1 from public.student_responses where id='50000000-0000-4000-8000-000000000001' for update$q$) t(n int);
select dblink_send_query('b',$q$select pg_temp.try_sql($s$delete from public.class_sessions where id='40000000-0000-4000-8000-000000000009'$s$)$q$);
select pg_sleep(0.1);
select pg_temp.assert_code(dblink_is_busy('b')::text,'1','live session delete waits for response');
select pg_temp.assert_code(code,'40001','response update versus live session delete') from dblink('a',$q$select pg_temp.try_sql($s$update public.student_responses set answer_json='{"choiceIndices":[]}' where id='50000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'ok','live session delete completes without deadlock') from dblink_get_result('b') t(code text);
select * from dblink_get_result('b') t(code text);
select dblink_exec('a','begin');
select * from dblink('a',$q$select 1 from public.student_responses where id='50000000-0000-4000-8000-000000000002' for update$q$) t(n int);
select dblink_send_query('b',$q$select pg_temp.try_sql($s$delete from public.class_sessions where id='40000000-0000-4000-8000-000000000010'$s$)$q$);
select pg_sleep(0.1);
select pg_temp.assert_code(dblink_is_busy('b')::text,'1','ended session delete waits for response');
select pg_temp.assert_code(code,'40001','response grading versus ended session delete') from dblink('a',$q$select pg_temp.try_sql($s$select public.grade_my_quiz_response('40000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000001')$s$)$q$) t(code text);
select dblink_exec('a','commit');
select pg_temp.assert_code(code,'ok','ended session delete completes without deadlock') from dblink_get_result('b') t(code text);
select * from dblink_get_result('b') t(code text);
select dblink_exec('a','reset request.jwt.claim.sub');
delete from auth.users where id='10000000-0000-4000-8000-000000000002';

-- LIMITATION REGRESSION: serializing individual requests does NOT make two
-- committed HTTP requests atomic. A start can commit in the gap. The old key
-- remains paired with the new option order and its subsequent update is denied.
-- This test deliberately proves the unresolved P1 rather than hiding it.
select dblink_exec('a',$q$update public.teacher_quiz_keys set correct_index=0 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$q$);
select dblink_exec('a',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["A","B"]') where id='20000000-0000-4000-8000-000000000001'$q$);
select dblink_exec('a',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='20000000-0000-4000-8000-000000000001'$q$);
select dblink_exec('b',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK238','live')$q$);
select pg_temp.assert_code(code,'55000','known gap: intended second key request is blocked') from dblink('a',$q$select pg_temp.try_sql($s$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(case when p.data #>> '{slides,0,content,options,0}'='B' and k.correct_index=0 then 'mixed' else 'other' end,'mixed','known gap: mismatched pair exists')
 from public.presentations p join public.teacher_quiz_keys k on k.presentation_id=p.id
 where p.id='20000000-0000-4000-8000-000000000001' and k.slide_id='30000000-0000-4000-8000-000000000001';
select dblink_exec('b',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000005'$q$);
-- The inverse gap is equally real: key commits first, start commits, then
-- the matching option change is rejected, leaving a mismatched pair.
select dblink_exec('a',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["A","B"]') where id='20000000-0000-4000-8000-000000000001'$q$);
select dblink_exec('a',$q$update public.teacher_quiz_keys set correct_index=1 where presentation_id='20000000-0000-4000-8000-000000000001' and slide_id='30000000-0000-4000-8000-000000000001'$q$);
select dblink_exec('b',$q$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('40000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','RSK23B','live')$q$);
select pg_temp.assert_code(code,'55000','inverse gap: intended second options request is blocked') from dblink('a',$q$select pg_temp.try_sql($s$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='20000000-0000-4000-8000-000000000001'$s$)$q$) t(code text);
select pg_temp.assert_code(case when p.data #>> '{slides,0,content,options,1}'='B' and k.correct_index=1 then 'mixed' else 'other' end,'mixed','inverse gap: mismatched pair exists')
 from public.presentations p join public.teacher_quiz_keys k on k.presentation_id=p.id
 where p.id='20000000-0000-4000-8000-000000000001' and k.slide_id='30000000-0000-4000-8000-000000000001';
select dblink_exec('b',$q$update public.class_sessions set status='ended' where id='40000000-0000-4000-8000-000000000008'$q$);
select dblink_disconnect('c');
select dblink_disconnect('a');
select dblink_disconnect('b');
delete from auth.users where id='10000000-0000-4000-8000-000000000001';
\echo 'Concurrency checks passed; the separate-request atomicity gap is deliberately demonstrated, not solved.'
