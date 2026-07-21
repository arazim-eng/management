-- 21.7.26 round 3: full names per Moshe
update projects set contact_name='קובי שמואלי', updated_at=now() where trim(contact_name)='קובי';
update projects set contact_name='שלומי שוקרון', updated_at=now() where trim(contact_name)='שלומי';
-- הדסה (נגישות), טליה (גוש עציון), סנדרה (תכנון), מוחמד (נגישות) — stay as-is per Moshe
