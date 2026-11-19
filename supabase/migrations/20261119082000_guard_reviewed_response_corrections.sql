-- Keep a teacher's existing score and feedback tied to the answer that was reviewed.
-- This additive migration does not change or delete existing response rows.
-- Students may correct an answer while it is unreviewed; after review, ask the
-- teacher to remove the review first. Teachers retain their existing permissions.
create or replace function public.prevent_reviewed_student_response_edits()
returns trigger
language plpgsql
set search_path = pg_catalog, public, auth
as $$
begin
  if public.is_plexia_student() and old.reviewed is true and (
    new.answer_text is distinct from old.answer_text
    or new.answer_json is distinct from old.answer_json
    or new.media_path is distinct from old.media_path
  ) then
    raise exception 'This response has already been reviewed and cannot be changed';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_reviewed_student_response_edits() from public, anon, authenticated;
drop trigger if exists prevent_reviewed_student_response_edits_trigger on public.student_responses;
create trigger prevent_reviewed_student_response_edits_trigger
before update of answer_text, answer_json, media_path on public.student_responses
for each row execute function public.prevent_reviewed_student_response_edits();
