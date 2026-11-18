alter function public.is_plexia_teacher() security invoker;
alter function public.is_plexia_student() security invoker;

alter policy "Users read their own profile"
on public.profiles
using (user_id = (select auth.uid()));

alter policy "Users update their own profile display name"
on public.profiles
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

alter policy "Teachers manage their own presentations"
on public.presentations
using (owner_id = (select auth.uid()) and (select public.is_plexia_teacher()))
with check (owner_id = (select auth.uid()) and (select public.is_plexia_teacher()));

alter policy "Teachers manage their own sessions"
on public.class_sessions
using (owner_id = (select auth.uid()) and (select public.is_plexia_teacher()))
with check (owner_id = (select auth.uid()) and (select public.is_plexia_teacher()));

alter policy "Participants read their own membership"
on public.session_participants
using (user_id = (select auth.uid()) and (select public.is_plexia_student()));

alter policy "Students submit one response per slide"
on public.student_responses
with check (
  participant_id = (select auth.uid())
  and (select public.is_plexia_student())
  and public.is_session_participant(session_id)
  and score is null
  and feedback is null
  and ai_evaluation is null
  and reviewed is false
  and exists (
    select 1
    from public.session_participants participant
    where participant.session_id = student_responses.session_id
      and participant.user_id = (select auth.uid())
      and participant.nickname = student_responses.nickname
  )
  and (
    media_path is null
    or media_path like (student_responses.session_id::text || '/' || (select auth.uid())::text || '/%')
  )
  and exists (
    select 1
    from public.class_sessions session
    join public.presentations presentation on presentation.id = session.presentation_id
    where session.id = student_responses.session_id
      and session.status = 'live'
      and session.activity_status not in ('paused', 'ended')
      and presentation.data -> 'slides' -> session.current_slide_index ->> 'id' = student_responses.slide_id::text
  )
);

alter policy "Students and teachers read permitted responses"
on public.student_responses
using (
  (participant_id = (select auth.uid()) and (select public.is_plexia_student()))
  or (public.is_session_owner(session_id) and (select public.is_plexia_teacher()))
);

alter policy "Teachers review responses for owned sessions"
on public.student_responses
using (public.is_session_owner(session_id) and (select public.is_plexia_teacher()))
with check (public.is_session_owner(session_id) and (select public.is_plexia_teacher()));
