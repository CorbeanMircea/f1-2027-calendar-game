-- 008: Broadcast changes to scores through Supabase Realtime.
-- Row Level Security still applies: players only receive changes for rows they may read.
alter publication supabase_realtime add table public.scores;
