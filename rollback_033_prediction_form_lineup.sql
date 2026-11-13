-- ROLLBACK for 033_prediction_form_lineup.sql: removes the read-only function. No data is touched.
-- Roll back the site files (predict-tiles.js, predict.html) first; the old predict-tiles.js does not call this function.
begin;
drop function public.prediction_form_lineup(text);
commit;
