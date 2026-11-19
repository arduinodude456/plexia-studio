-- Persisted group work assignments. Teachers may manage assignments for owned sessions;
-- participants may only read their own row (or teachers may read the whole roster).
alter table public.session_group_assignments enable row level security;
revoke all on public.session_group_assignments from public, anon, authenticated;
grant select, insert, delete on public.session_group_assignments to authenticated;

drop policy if exists "Participants read permitted group assignments" on public.session_group_assignments;
create policy "Participants read permitted group assignments"
on public.session_group_assignments
for select to authenticated
using (
  (user_id = (select auth.uid()) and (select public.is_plexia_student()) and public.is_session_participant(session_id))
  or ((select public.is_plexia_teacher()) and public.is_session_owner(session_id))
);

drop policy if exists "Teachers manage group assignments" on public.session_group_assignments;
create policy "Teachers manage group assignments"
on public.session_group_assignments
for insert to authenticated
with check ((select public.is_plexia_teacher()) and public.is_session_owner(session_id));

create policy "Teachers delete group assignments"
on public.session_group_assignments
for delete to authenticated
using ((select public.is_plexia_teacher()) and public.is_session_owner(session_id));

do $$
begin
  alter publication supabase_realtime add table public.session_group_assignments;
exception when duplicate_object then
  null;
end $$;
