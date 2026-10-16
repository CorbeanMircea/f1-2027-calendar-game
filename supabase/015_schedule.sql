-- 015: Schedules (pg_cron + pg_net). Everything is UTC.
-- Needs: pg_cron and pg_net enabled, and a Vault secret named 'import_secret'.
-- The secret is read from the Vault when each job runs; it is not stored in this file.

-- Session times: once a day.
select cron.schedule(
  'import-session-times-daily',
  '15 6 * * *',
  $job$
  select net.http_get(
    url := 'https://qcofaxawphewcrfgiaej.supabase.co/functions/v1/import-results?task=times&mode=import',
    headers := jsonb_build_object(
      'x-import-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'import_secret')
    ),
    timeout_milliseconds := 55000
  );
  $job$
);

-- Results: every 30 minutes. The function only does real work for events in the
-- current race-weekend window (weekend start until 3 days after the weekend ends).
select cron.schedule(
  'import-results-every-30-min',
  '*/30 * * * *',
  $job$
  select net.http_get(
    url := 'https://qcofaxawphewcrfgiaej.supabase.co/functions/v1/import-results?task=results&mode=import',
    headers := jsonb_build_object(
      'x-import-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'import_secret')
    ),
    timeout_milliseconds := 55000
  );
  $job$
);

-- Housekeeping: keep only 14 days of job history.
select cron.schedule(
  'cleanup-cron-history',
  '30 3 * * *',
  $job$
  delete from cron.job_run_details where end_time < now() - interval '14 days';
  $job$
);