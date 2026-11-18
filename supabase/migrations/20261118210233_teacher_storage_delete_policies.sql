-- Let a teacher remove media only from presentations/sessions they own.
-- The client must use Supabase Storage API .remove(), which deletes the object
-- from the storage provider; deleting storage.objects rows with SQL is not used.
create policy "Teachers delete their presentation media"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'presentation-media'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
  and (select public.is_plexia_teacher())
);

create policy "Teachers delete photos from owned sessions"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'student-uploads'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and (select public.is_plexia_teacher())
  and case
    when (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
    then (select public.is_session_owner(((storage.foldername(name))[1])::uuid))
    else false
  end
);
