revoke all on function public.create_profile_for_auth_user() from public, anon, authenticated;
grant execute on function public.create_profile_for_auth_user() to supabase_auth_admin;

create index if not exists class_sessions_presentation_id_idx
  on public.class_sessions (presentation_id);
create index if not exists session_participants_user_id_idx
  on public.session_participants (user_id);
create index if not exists student_responses_participant_id_idx
  on public.student_responses (participant_id);
