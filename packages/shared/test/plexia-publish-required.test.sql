-- SECURITY REGRESSION: raw split writes and retries must remain unpublished.
-- Disposable LOCAL PostgreSQL only, as a local superuser after all migrations.
-- dblink connections are separate committed transactions, not a network service.
-- The editor must use publish_presentation_with_quiz_keys for the paired
-- presentation/key snapshot. A start on raw dirty material must raise SQLSTATE
-- 55000; permission, timeout or constraint failures are NOT a pass.
-- This test uses direct superuser writes to exercise trigger protection even for
-- writers bypassing table grants; it does not claim direct legacy writes are safe.
-- Fixtures are removed before the final assertion, including when assertions fail.
\set ON_ERROR_STOP on
create extension if not exists dblink;
create temporary table publish_check(label text, passed boolean, detail text);

insert into auth.users(id,is_anonymous,raw_user_meta_data)
 values ('12000000-0000-4000-8000-000000000001',false,'{}');
insert into public.presentations(id,owner_id,title,data) values
 ('22000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Options first',
  '{"slides":[{"id":"32000000-0000-4000-8000-000000000001","type":"multiple_choice","content":{"question":"Q","options":["A","B"],"allowMultiple":false}}]}'),
 ('22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','Key first',
  '{"slides":[{"id":"32000000-0000-4000-8000-000000000002","type":"multiple_choice","content":{"question":"Q","options":["A","B"],"allowMultiple":false}}]}'),
 ('22000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001','Failed retry',
  '{"slides":[{"id":"32000000-0000-4000-8000-000000000003","type":"multiple_choice","content":{"question":"Q","options":["A","B"],"allowMultiple":false}}]}');
insert into public.teacher_quiz_keys(presentation_id,slide_id,owner_id,correct_index) values
 ('22000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',0),
 ('22000000-0000-4000-8000-000000000002','32000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001',0),
 ('22000000-0000-4000-8000-000000000003','32000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001',0);

select dblink_connect('publisher','dbname=' || current_database());
select dblink_connect('starter','dbname=' || current_database());
select dblink_exec('publisher','set statement_timeout = ''3s''');
select dblink_exec('starter','set statement_timeout = ''3s''');
select dblink_exec('starter',$q$create function pg_temp.try_sql(cmd text) returns text language plpgsql as $f$
 begin execute cmd; return 'ok'; exception when others then return sqlstate; end $f$$q$);

-- Request 1: reordered options committed. Request 2 has not yet written key.
select dblink_exec('publisher',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='22000000-0000-4000-8000-000000000001'$q$);
insert into publish_check
 select 'options first: session start between requests rejected', code = '55000', code
 from dblink('starter',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('42000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','PUB234','live')$s$)$q$) t(code text);
-- If the broken server let the session start, end it before continuing so that
-- cleanup is deterministic and later checks do not depend on its freeze guard.
update public.class_sessions set status='ended' where id='42000000-0000-4000-8000-000000000001';

-- Inverse ordering: private key is committed but option order is not.
select dblink_exec('publisher',$q$update public.teacher_quiz_keys set correct_index=1 where presentation_id='22000000-0000-4000-8000-000000000002'$q$);
insert into publish_check
 select 'key first: session start between requests rejected', code = '55000', code
 from dblink('starter',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('42000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002','PUB235','live')$s$)$q$) t(code text);
update public.class_sessions set status='ended' where id='42000000-0000-4000-8000-000000000002';

-- A later key request rolls back; session start must still be refused. Retrying
-- the raw key write cannot on its own attest that the pair was published: only
-- an authorized atomic/publish protocol can clear that condition.
select dblink_exec('publisher',$q$update public.presentations set data=jsonb_set(data,'{slides,0,content,options}','["B","A"]') where id='22000000-0000-4000-8000-000000000003'$q$);
select dblink_exec('publisher','begin');
select dblink_exec('publisher',$q$update public.teacher_quiz_keys set correct_index=1 where presentation_id='22000000-0000-4000-8000-000000000003'$q$);
select dblink_exec('publisher','rollback');
insert into publish_check
 select 'rolled-back key request: session start rejected', code = '55000', code
 from dblink('starter',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('42000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','PUB236','live')$s$)$q$) t(code text);
update public.class_sessions set status='ended' where id='42000000-0000-4000-8000-000000000003';
select dblink_exec('publisher',$q$update public.teacher_quiz_keys set correct_index=1 where presentation_id='22000000-0000-4000-8000-000000000003'$q$);
insert into publish_check
 select 'unattested raw retry: session start rejected', code = '55000', code
 from dblink('starter',$q$select pg_temp.try_sql($s$insert into public.class_sessions(id,owner_id,presentation_id,join_code,status) values ('42000000-0000-4000-8000-000000000004','12000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','PUB237','live')$s$)$q$) t(code text);
update public.class_sessions set status='ended' where id='42000000-0000-4000-8000-000000000004';
select dblink_disconnect('publisher');
select dblink_disconnect('starter');
delete from auth.users where id='12000000-0000-4000-8000-000000000001';

select * from publish_check order by label;
do $$ declare failures text; begin
 select string_agg(label || ' [' || detail || ']', '; ' order by label) into failures
 from publish_check where not passed;
 if failures is not null then
   raise exception 'UNSAFE: unpublished quiz material became live: %', failures;
 end if;
end $$;
\echo 'PASS: raw partial/retried changes never become live without publication.'
