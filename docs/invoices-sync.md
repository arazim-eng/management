# סנכרון ממערכת החשבוניות לטבלת החשבונות

מ-22.9.26 מערכת החשבוניות (`invoices.arazim-eng.co.il`) היא המקום **היחיד**
שמפיקים בו מסמכים. סאמיט ואיזי קאונט קפואים. כדי שטבלת החשבונות תישאר
מעודכנת, יש סנכרון חד-כיווני: מושכים משם, כותבים לכאן. **לעולם לא להיפך** —
שום דבר בטבלת הניהול לא חוזר למערכת החשבוניות.

## מה רץ ומתי

| מה | איפה | מתי |
|---|---|---|
| `invoices-sync` (Edge Function) | `supabase/functions/invoices-sync/` | כל 15 דקות, `pg_cron` job בשם `invoices-sync-15min` |
| המיפוי הטהור (נבדק) | `supabase/functions/invoices-sync/mapping.js` | — |
| בדיקות | `test/invoices-sync-mapping.test.mjs` | `node --test 'test/*.test.mjs'` |
| הרצה יבשה | `scripts/invoices-sync-dry.mjs` | ידנית |
| טבלת סימן המים + התזמון | `supabase/migrations/20260922_invoices_sync.sql` | מיגרציה חד-פעמית |

כל ריצה מושכת מ-`GET /api/v1/documents` רק את מה שנוצר מאז הריצה המוצלחת
האחרונה (שורת `sync_state` עם `source='arazim-invoices'`), פחות חלון חפיפה של
10 דקות. הריצה אידמפוטנטית: אפשר להריץ אותה שוב ושוב בלי לשכפל ובלי לספור
פעמיים.

## המיפוי

| `doc_type` ב-API | `invoice_type` בטבלה | סימן הסכום | סטטוס ראשוני |
|---|---|---|---|
| `tax_invoice` | חשבונית מס | חיובי | `sent` |
| `tax_invoice_receipt` | חשבונית מס קבלה | חיובי | `paid` |
| `receipt` | קבלה | חיובי | `paid` |
| `donation_receipt` | קבלה על תרומה | חיובי | `paid` |
| `proforma` | חשבון עסקה | חיובי | `sent` |
| `credit_note` | חשבונית זיכוי | **שלילי** | `sent` |
| `quote`, `work_order`, `purchase_order`, `delivery_note`, `return_note`, `deposit_receipt`, `deposit_use` | — | מדולג | — |

* **סכום**: `total_agorot / 100` — שקלים **כולל מע"מ**, בדיוק כמו
  `doc_price_total` של איזי קאונט ובדיוק מה שהטבלה מחזיקה היום.
* **ישות**: `entity_id` (uuid) → `עוסק` / `חברה` לפי הסוד `INVOICES_ENTITY_MAP`.
  מסמך של ישות לא מוכרת **מדולג ומדווח** — שיוך כספי לא מנחשים.
* **מזהה השורה**: `arz-<uuid של המסמך>` (כמו `ezcount-<uuid>` בזמנו).
* **`file_url`**: `…/api/v1/documents/<id>/pdf`. הקישור נפתח בדפדפן רק כשמשה
  מחובר למערכת החשבוניות באותו דפדפן (הנתיב דורש הרשאה).

### מה הסנכרון לא דורס
על שורה שכבר קיימת נכתבים רק `invoice_number`, `invoice_type`, `amount`,
`entity`, `date_sent`, `file_url` — ורק אם הם באמת השתנו. `status`, `date_paid`,
`notes`, `project_id`, `submitted_to_muni`, `closes_id`, `exclude_cashflow`
נקבעים בשורה החדשה בלבד, ומשם והלאה שייכים לעבודה הידנית של משה.

### מיזוג וכפילויות
הלוגיקה נלקחה **כמות שהיא** מ-`ezcount-webhook` (הערת 10.8.26 שם): אם קיימת
שורה שנרשמה **ידנית** עם אותו מספר מסמך, אותה ישות, וסכום זהה או ×1.18
(ידני בלי מע"מ מול כולל מע"מ) — השורה החדשה יורשת ממנה את השיוך לפרויקט,
ההגשה לעירייה, שרשרת הסגירה, דגל התזרים וסטטוס "שולם", והשורה הידנית נמחקת.
תוספת אחת: גם התאמת **ישות**, כי מערכת החשבוניות מספרת בנפרד לעוסק ולחברה.

שורה של `ezcount-` / `sumit-` עם אותו מספר וסכום **לא** ממוזגת ולא נמחקת
("לא נוגעים בהן לעולם") — היא מדווחת כ-`conflict` והסנכרון מדלג, כדי שלא
ייספר אותו כסף פעמיים. אם צצות התנגשויות, מישהו צריך להכריע ידנית.

## סודות שצריך להגדיר

סודות של הפונקציה (Supabase → Edge Functions → Secrets, או
`supabase secrets set --project-ref kwmldvcsucbuvsjsiuaq`):

| שם | מה זה |
|---|---|
| `INVOICES_API_KEY` | מפתח API של מערכת החשבוניות, **scope יחיד: `documents:read`** |
| `INVOICES_API_BASE` | `https://invoices.arazim-eng.co.il` (ברירת מחדל — אפשר לא להגדיר) |
| `INVOICES_ENTITY_MAP` | `{"<uuid של החברה>":"חברה","<uuid של העוסק>":"עוסק"}` |

`SUPABASE_URL` ו-`SUPABASE_SERVICE_ROLE_KEY` מסופקים אוטומטית.

**יצירת המפתח** (במאגר של מערכת החשבוניות, לא כאן):
```
node --env-file=.env.local --env-file=.env scripts/new-api-key.mjs "ארזים" "סנכרון לטבלת הניהול" documents:read
```
המפתח מוצג פעם אחת בלבד. **רק `documents:read`** — לסנכרון אין שום סיבה
לכתוב מסמכים, ליצור לקוחות או לגעת בסליקה.

**ה-uuid של הישויות**: `GET /entities` עדיין לא ממומש ב-API, ולכן שולפים
אותם פעם אחת מהמסד של מערכת החשבוניות:
```sql
select id, name, tax_id, kind from entities;
```
`516081387` (מ.ס ארזים הנדסה בע״מ) → `חברה`, `201608239` (משה סעדה) → `עוסק`.

## הפעלה ראשונה

1. פריסת הפונקציה: `supabase functions deploy invoices-sync`.
2. הגדרת שלושת הסודות למעלה.
3. הרצת המיגרציה `20260922_invoices_sync.sql` (יוצרת `sync_state` ואת ה-cron).
4. **הרצה יבשה לפני הכול** (ראו למטה) — לוודא שהסכומים, הישויות והסוגים נכונים.
5. מילוי למפרע חד-פעמי, אם כבר הופקו מסמכים לפני שהתזמון עלה:
   `node scripts/invoices-sync-dry.mjs --apply --from 2026-09-01`

## הרצה יבשה ומילוי למפרע

```
export SB_ANON=<מפתח ה-anon של פרויקט הניהול>

node scripts/invoices-sync-dry.mjs                    # מה ייכתב בריצה הבאה
node scripts/invoices-sync-dry.mjs --from 2026-09-01  # מילוי למפרע — יבש
node scripts/invoices-sync-dry.mjs --all              # כל ההיסטוריה — יבש
node scripts/invoices-sync-dry.mjs --apply --from 2026-09-01   # ⚠️ כותב
```

`dry=1` לא נוגע במסד בכלל — גם לא בסימן המים. הפלט מראה לכל מסמך אם הוא
ייכתב כשורה חדשה, יעדכן שורה קיימת, ימוזג עם שורה ידנית או ידולג — בלי
שמות לקוחות.

## איך מוודאים שזה עובד

```sql
-- מתי רץ לאחרונה ועד איפה הגיע
select * from sync_state where source = 'arazim-invoices';

-- שורות שהגיעו מהסנכרון
select count(*), min(date_sent), max(date_sent) from invoices where id like 'arz-%';

-- ה-cron רץ?
select jobname, schedule, active from cron.job where jobname = 'invoices-sync-15min';
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'invoices-sync-15min')
 order by start_time desc limit 10;
```

בלוגים של הפונקציה יש שורה אחת לריצה עם מספרים בלבד
(`scanned/insert/update/merge/skipped/conflicts/errors`) — **בלי שמות לקוחות
ובלי מפתחות**.

`last_created_at` מתקדם רק בריצה **ללא שגיאות**. אם יש שגיאה, הריצה הבאה
תסרוק שוב את אותו טווח — הכתיבה אידמפוטנטית ולכן זה בטוח.

## דבר אחד שצריך להחליט (⚠️)

טבלת הניהול סופרת כסף לפי **שם הסוג המדויק** `'חשבונית מס'`
(`invCertain` / `inCashflow` / `projFin` ב-`index.html`). משמעות:

* **חשבונית מס קבלה** לא נספרת כהכנסה ולא נכנסת לתזרים.
* **חשבונית זיכוי** נשמרת שלילית — אבל גם היא לא נספרת, ולכן לא מקזזת.

זה נכון כבר היום לשורות של איזי קאונט, אבל עד עכשיו כמעט לא היו כאלה.
אם במערכת החשבוניות מפיקים חשבוניות מס-קבלה או זיכויים, צריך להרחיב את
שלוש הפונקציות האלה לקבוצת סוגים במקום השוואה אחת. הסנכרון לא משנה את
הכלל הזה מיוזמתו — הוא רק כותב את השורות נאמנה.

## מה עוד היה אפשר, ומה חוסם

`closes_id` (שרשרת "חשבון עסקה → חשבונית מס" בטבלת הניהול) לא מתמלא
אוטומטית: למסמך במערכת החשבוניות יש `ref_document_id` שמצביע בדיוק על זה,
אבל `GET /api/v1/documents` לא מחזיר את השדה ברשימה (רק
`GET /documents/{id}` מחזיר אותו, וזו קריאה למסמך). אם יתווסף
`ref_document_id` ל-`select` של הרשימה, אפשר יהיה לסגור את השרשרת לבד
ולחסוך את "דרושה הוצאת חשבונית מס" הידני. **זה שינוי במאגר של מערכת
החשבוניות — לא בוצע כאן.**
