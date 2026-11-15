-- ROLLBACK for 037_prediction_corrections.sql
-- Removes the functions, and the audit table ONLY if it is empty. If corrections were made, the table is KEPT (with a notice)
-- and the corrected picks and the recalculated scores stay as they are: a rollback never silently changes predictions or scores.
-- To undo a correction itself, revert it from the Admin screen BEFORE running this file.
-- Roll back the site files and the push function first.
begin;

drop function public.admin_preview_corrections(text);
drop function public.admin_correct_predictions(text, jsonb, text, uuid, uuid);
drop function public.admin_revert_correction(uuid, text);
drop function public.rescore_prediction(uuid, text);

do $$
begin
  if (select count(*) from public.prediction_corrections) = 0 then
    drop table public.prediction_corrections;
    raise notice 'prediction_corrections was empty and has been removed.';
  else
    raise notice 'prediction_corrections contains rows and was KEPT (no data was removed).';
  end if;
end;
$$;

commit;
