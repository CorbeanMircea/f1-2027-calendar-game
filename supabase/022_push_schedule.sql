-- 022: Run the reminder check every 15 minutes (pg_cron + pg_net, everything is UTC).
-- Needs the Vault secret 'import_secret' (the same one the result importer uses) and the
-- send-reminders edge function deployed. Run this AFTER 021 and after deploying the function.

select cron.schedule(
  'send-push-reminders-every-15-min',
  '*/15 * * * *',
  $job$
  select net.http_get(
    url := 'https://qcofaxawphewcrfgiaej.supabase.co/functions/v1/send-reminders?task=reminders',
    headers := jsonb_build_object(
      'x-import-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'import_secret')
    ),
    timeout_milliseconds := 55000
  );
  $job$
);

-- To stop the reminders at any time:
--   select cron.unschedule('send-push-reminders-every-15-min');
