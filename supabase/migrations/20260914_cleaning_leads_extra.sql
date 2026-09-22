-- שדות נוספים שמשה ביקש מהמזכירה (14.9 לילה): גיל, היקף, משרה מלאה, עבודה קודמת, קצבה/פנסיה, מגבלות
alter table cleaning_worker_leads
  add column if not exists age int,
  add column if not exists availability_note text,   -- "כמה זמן יכולה לעבוד": שעות/ימים/מתי מתחילה
  add column if not exists full_time text,           -- yes / no / maybe
  add column if not exists previous_work text,
  add column if not exists benefits text,            -- קצבה/פנסיה: none / pension / allowance / other + פירוט
  add column if not exists limitations text;         -- מגבלות רלוונטיות לעבודה
