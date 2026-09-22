#!/usr/bin/env node
/**
 * הרצה יבשה של הסנכרון — מדפיס מה **היה** נכתב לטבלת החשבונות, בלי לכתוב.
 * הפונקציה עצמה לא נוגעת במסד כש-dry=1 דולק, כולל סימן המים.
 *
 * שימוש:
 *   node scripts/invoices-sync-dry.mjs                 # מסימן המים ואילך
 *   node scripts/invoices-sync-dry.mjs --from 2026-09-01
 *   node scripts/invoices-sync-dry.mjs --all           # כל ההיסטוריה
 *   node scripts/invoices-sync-dry.mjs --apply --from 2026-09-01   # ⚠️ כותב באמת
 *
 * סביבה:
 *   SB_URL   (ברירת מחדל: פרויקט הניהול)
 *   SB_ANON  מפתח anon של הפרויקט — ה-gateway דורש JWT (verify_jwt).
 *            זה מפתח ציבורי (הוא יושב גם ב-index.html), לא סוד.
 * ‏מפתח ה-API של מערכת החשבוניות **לא** עובר כאן — הוא יושב כסוד של הפונקציה.
 */
const SB_URL = process.env.SB_URL || 'https://kwmldvcsucbuvsjsiuaq.supabase.co';
const SB_ANON = process.env.SB_ANON || '';
if (!SB_ANON) {
  console.error('חסר SB_ANON (מפתח ה-anon של פרויקט הניהול).');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const url = new URL(`${SB_URL}/functions/v1/invoices-sync`);
if (!flag('--apply')) url.searchParams.set('dry', '1');
if (val('--from')) url.searchParams.set('from', val('--from'));
if (flag('--all')) url.searchParams.set('all', '1');

if (flag('--apply')) console.log('⚠️  מצב כתיבה אמיתי (--apply)\n');
console.log('קורא ל-', url.pathname + url.search, '\n');

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${SB_ANON}`, 'Content-Type': 'application/json' },
});
const out = await res.json();
if (!res.ok || out.error) { console.error('שגיאה:', JSON.stringify(out, null, 2)); process.exit(1); }

const n = (k) => String(out[k] ?? 0).padStart(5);
console.log('נסרקו מסמכים      ', n('scanned'), `(${out.pages} עמודים)`);
console.log('שורות חדשות        ', n('insert'));
console.log('עדכון שורה קיימת   ', n('update'));
console.log('מיזוג עם שורה ידנית', n('merge'));
console.log('ללא שינוי          ', n('unchanged'));
console.log('דולגו               ', n('skipped'), JSON.stringify(out.skipped_by_reason ?? {}));
console.log('התנגשויות          ', n('conflicts'));
if (out.conflicts?.length) {
  console.log('\n⚠️  אותו מסמך קיים כבר משורת איזי קאונט/סאמיט — לא נכתב כדי לא להיספר פעמיים:');
  out.conflicts.forEach((c) => console.log('   ', c));
}
if (out.scanned_note) console.log('\nℹ️ ', out.scanned_note);

if (out.sample?.length) {
  console.log('\nדוגמה (עד 50 שורות; בלי שמות לקוחות):');
  const pad = (s, w) => String(s ?? '').padEnd(w);
  console.log(pad('פעולה', 9), pad('מס׳', 8), pad('סוג', 18), pad('ישות', 6), pad('סכום', 12), 'תאריך');
  for (const s of out.sample) {
    console.log(pad(s.action, 9), pad(s.number, 8), pad(s.type, 18), pad(s.entity, 6), pad(s.amount, 12), s.date_sent ?? '');
  }
}
