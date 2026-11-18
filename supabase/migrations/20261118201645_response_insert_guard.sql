alter policy "Students submit one response per slide"
on public.student_responses
with check (
  participant_id = auth.uid()
  and public.is_plexia_student()
  and public.is_session_participant(session_id)
  and score is null
  and feedback is null
  and ai_evaluation is null
  and reviewed is false
  and exists (
    select 1
    from public.session_participants participant
    where participant.session_id = student_responses.session_id
      and participant.user_id = auth.uid()
      and participant.nickname = student_responses.nickname
  )
  and (
    media_path is null
    or media_path like (student_responses.session_id::text || '/' || auth.uid()::text || '/%')
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
