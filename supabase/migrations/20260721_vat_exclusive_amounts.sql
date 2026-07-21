-- 21.7.26: project amounts become VAT-exclusive (Moshe's request — secretary was
-- entering incl-VAT amounts; from now the form takes ex-VAT and shows incl-VAT auto).
-- Existing data was entered incl-VAT → divide by 1.18.
-- Skipped: 3 rows already stored ex-VAT (converted in a past session, /1.18 fingerprint):
--   1w38q1tn (בי"ס ארזים), keqy2tth (אום טובה), 3jn13nzq (עמיטל הר חומה)
-- Backup: projects-backup-pre-vat-21jul.json (scratchpad + OneDrive ניהול חשבונות ארזים)

update projects set
  scope_amount = round((scope_amount/1.18)::numeric, 2),
  supervision_amount = round((supervision_amount/1.18)::numeric, 2),
  updated_at = now()
where project_type = 'regular'
  and id not in ('1w38q1tn','keqy2tth','3jn13nzq')
  and (scope_amount is not null or supervision_amount is not null);

-- normalize supervision_pct to percent convention (4.5, not 0.045), derived from actual amounts
update projects set
  supervision_pct = round((supervision_amount/scope_amount*100)::numeric, 2)
where project_type = 'regular'
  and coalesce(scope_amount,0) > 0 and coalesce(supervision_amount,0) > 0;
