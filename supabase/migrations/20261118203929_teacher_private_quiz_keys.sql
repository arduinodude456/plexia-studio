-- Private answer keys for teacher-created quizzes. Never include these values in
-- presentations.data, class-session RPC payloads, or student-readable tables.
create table if not exists public.teacher_quiz_keys (
  presentation_id uuid not null references public.presentations(id) on delete cascade,
  slide_id uuid not null,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  correct_index integer not null check (correct_index >= 0),
  explanation text not null default '' check (char_length(explanation) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (presentation_id, slide_id)
);

create index if not exists teacher_quiz_keys_owner_idx
  on public.teacher_quiz_keys (owner_id, presentation_id);

alter table public.teacher_quiz_keys enable row level security;

revoke all on public.teacher_quiz_keys from anon, authenticated;
grant select, insert, update, delete on public.teacher_quiz_keys to authenticated;

create policy "Teachers manage private answer keys for their presentations"
on public.teacher_quiz_keys
for all to authenticated
using (
  owner_id = auth.uid()
  and public.is_plexia_teacher()
  and exists (
    select 1 from public.presentations p
    where p.id = teacher_quiz_keys.presentation_id
      and p.owner_id = auth.uid()
  )
)
with check (
  owner_id = auth.uid()
  and public.is_plexia_teacher()
  and exists (
    select 1 from public.presentations p
    where p.id = teacher_quiz_keys.presentation_id
      and p.owner_id = auth.uid()
  )
);

comment on table public.teacher_quiz_keys is
  'Teacher-only answer keys. Keep answer keys and explanations out of all student-visible presentation JSON and RPC responses.';
