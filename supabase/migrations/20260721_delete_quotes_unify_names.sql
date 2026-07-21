-- 21.7.26 (Moshe's request):
-- 1) הצעות מחיר / דרישות תשלום — "תמחוק הכל לא מעניין". Backup: invoices-backup-21jul.json
delete from invoices where invoice_type in ('הצעת מחיר','דרישה לתשלום','דרישת תשלום');

-- 2) unify handler first+last names (bare names → full)
update projects set contact_name='לאה סנדרס', updated_at=now() where trim(contact_name)='לאה';
update projects set contact_name='תהילה ארז', updated_at=now() where trim(contact_name)='תהילה';
update projects set contact_name='שמואל לשם', updated_at=now() where trim(contact_name)='שמואל';

-- 3) client "אחר" support — free-text client name
alter table projects add column if not exists custom_client text;
