-- Include presentation UPDATEs in realtime so joined students can receive
-- explicitly shared, solution-key-free results. The existing SELECT RLS policy
-- limits row delivery to teachers and participants of an active presentation.
alter publication supabase_realtime add table public.presentations;
