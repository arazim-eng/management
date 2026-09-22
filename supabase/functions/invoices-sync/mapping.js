/**
 * מיפוי מסמך ממערכת החשבוניות (arazim-invoices) לשורה בטבלת הניהול.
 *
 * למה קובץ נפרד ו-.js ולא .ts: הפונקציות כאן טהורות (בלי רשת ובלי מסד),
 * כדי שאפשר יהיה לבדוק אותן ב-node (`node --test test/`) בלי Deno ובלי
 * גישה לפרודקשן. Deno מייבא .js מתוך .ts בלי בעיה.
 *
 * הכלל המנחה: השורות שנוצרות כאן חייבות להיראות בדיוק כמו השורות של
 * ezcount-webhook — אותה טבלה, אותו UI, אותם שמות סוגים בעברית. כל מה
 * שאפשר היה לקחת משם נלקח משם ולא נכתב מחדש (ראו hoard של הערות למטה).
 */

/**
 * סוגי מסמך → השם בעברית בטבלת הניהול.
 * ‏⚠️ האיות נלקח **מ-TYPE_MAP של ezcount-webhook** ולא מ-DOC_LABELS של מערכת
 * החשבוניות: שם "חשבונית מס קבלה" (בלי מקף) כבר יושב על שורות קיימות בטבלה,
 * ושינוי איות היה יוצר שני סוגים שנראים זהים למשתמש ומתפצלים בכל סינון.
 */
export const DOC_TYPE_LABELS = {
  tax_invoice: 'חשבונית מס',
  tax_invoice_receipt: 'חשבונית מס קבלה',
  receipt: 'קבלה',
  donation_receipt: 'קבלה על תרומה',
  proforma: 'חשבון עסקה',
  credit_note: 'חשבונית זיכוי',
};

/**
 * מה לא נכנס לטבלה.
 * ‏quote = הצעת מחיר ו-work_order/purchase_order = הזמנה — בדיוק מה
 * ש-ezcount-webhook מדלג עליו (קודים 100 ו-200, "21.7.26 משה: הצעות מחיר
 * והזמנות לא מעניינות"). תעודות משלוח/החזרה ופיקדונות מעולם לא היו בטבלה
 * ואין להן משמעות כספית במודל שלה — מדלגים ומדווחים, לא ממציאים סוג חדש.
 */
export const SKIP_TYPES = [
  'quote', 'work_order', 'purchase_order', 'delivery_note', 'return_note',
  'deposit_receipt', 'deposit_use',
];

/** מסמכים שהם תקבול בעצמם — נרשמים ישר כ"שולם" ולא כ"נשלח וממתין". */
const PAID_ON_ISSUE = ['tax_invoice_receipt', 'receipt', 'donation_receipt'];

/** קידומות של מקורות אוטומטיים אחרים — שורות כאלה לא נוגעים בהן לעולם. */
export const AUTOMATED_PREFIXES = ['ezcount-', 'sumit-', 'arz-'];

/** אגורות (שלם) → שקלים עם 2 ספרות, כמו שהטבלה מחזיקה סכומים. */
export function agorotToShekels(agorot) {
  return Math.round(Number(agorot) || 0) / 100;
}

/**
 * מסמך מה-API → שורה לטבלה, או סיבת דילוג.
 * מחזיר תמיד את אותה צורה — `{ skip, row, docType }`, כשאחד מהם null —
 * כדי שבדיקת הטיפוסים של Deno תוכל לגעת בכל שדה בלי union מפוצל.
 *
 * @param doc מסמך כפי ש-GET /api/v1/documents מחזיר (שדות: id, entity_id,
 *   doc_type, doc_number, issue_date, client_snapshot, total_agorot, created_at)
 * @param entityMap מיפוי entity_id (uuid) → 'עוסק' / 'חברה'
 * @param pdfBase בסיס כתובת ל-PDF (למשל https://invoices.arazim-eng.co.il)
 */
export function mapDocument(doc, entityMap, pdfBase) {
  const drop = (reason) => ({ skip: reason, row: null, docType: null });
  if (!doc || !doc.id) return drop('no_id');
  const docType = String(doc.doc_type || '');
  if (SKIP_TYPES.includes(docType)) return drop('type:' + docType);
  const label = DOC_TYPE_LABELS[docType];
  if (!label) return drop('unknown_type:' + docType);

  // הישות היא שיוך כספי — לא מנחשים. ישות לא מוכרת = שגיאה שמדווחת,
  // כדי שלא ייווצרו חשבוניות של החברה תחת העוסק ולהיפך.
  const entity = entityMap[doc.entity_id];
  if (!entity) return drop('unknown_entity');

  // total_agorot כולל מע"מ — בדיוק כמו doc_price_total של איזי קאונט,
  // וזה מה שטבלת הניהול מחזיקה (ראו לוגיקת המיזוג עם שורה ידנית ×1.18).
  const total = agorotToShekels(doc.total_agorot);
  const isCredit = docType === 'credit_note';

  const row = {
    id: 'arz-' + doc.id,
    invoice_number: String(doc.doc_number ?? ''),
    invoice_type: label,
    // זיכוי נשמר שלילי — אותה מוסכמה כמו ezcount-webhook (קוד 330)
    amount: isCredit ? -Math.abs(total) : total,
    entity,
    date_sent: doc.issue_date || null,
    status: PAID_ON_ISSUE.includes(docType) ? 'paid' : 'sent',
    notes: (doc.client_snapshot && doc.client_snapshot.name) || null,
    file_url: pdfBase ? `${pdfBase}/api/v1/documents/${doc.id}/pdf` : null,
  };
  if (row.status === 'paid') row.date_paid = doc.issue_date || null;
  return { skip: null, row, docType };
}

/**
 * השדות שהסנכרון "בעלים" עליהם — רק הם נכתבים מחדש על שורה קיימת.
 * ‏status/notes/date_paid **לא** ברשימה בכוונה: משה מסמן "שולם" בטבלה
 * ומוסיף הערות, וריצה כל 15 דקות שדורסת אותם הייתה מוחקת עבודה ידנית.
 * (ל-ezcount-webhook לא הייתה בעיה כזו — הוא נורה פעם אחת פר מסמך.)
 */
export const OWNED_FIELDS = ['invoice_number', 'invoice_type', 'amount', 'entity', 'date_sent', 'file_url'];

/** אילו מהשדות שבבעלות הסנכרון שונים בשורה הקיימת (ריק = אין מה לכתוב). */
export function changedFields(existing, row) {
  const out = [];
  for (const f of OWNED_FIELDS) {
    const a = existing[f] == null ? null : existing[f];
    const b = row[f] == null ? null : row[f];
    if (f === 'amount') {
      if (Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.005) out.push(f);
    } else if (String(a ?? '') !== String(b ?? '')) out.push(f);
  }
  return out;
}

/**
 * זיהוי שורה ידנית שנרשמה על אותו מסמך — **הלוגיקה של ezcount-webhook
 * (10.8.26), מועתקת ולא מומצאת מחדש**:
 *   • אותו מספר מסמך
 *   • לא שורה של מקור אוטומטי (ezcount-/sumit-/arz-)
 *   • הסכום זהה, או ידני-בלי-מע"מ מול כולל-מע"מ (×1.18), בסבילות של ₪2
 * תוספת אחת שלנו: גם **אותה ישות**. איזי קאונט הזין רק את העוסק, ולכן
 * מספר מסמך הספיק; מערכת החשבוניות מספרת בנפרד לעוסק ולחברה, ובלי הסינון
 * הזה חשבונית 1001 של החברה הייתה יכולה לבלוע שורה ידנית 1001 של העוסק.
 */
export function pickManualDuplicate(candidates, row) {
  return (candidates || []).find((r) => {
    if (!r || r.id === row.id) return false;
    if (AUTOMATED_PREFIXES.some((p) => String(r.id).startsWith(p))) return false;
    if (r.entity && r.entity !== row.entity) return false;
    const a = Math.abs(Number(r.amount) || 0), b = Math.abs(row.amount) || 0;
    if (!a || !b) return false;
    return Math.abs(a - b) <= 2 || Math.abs(a * 1.18 - b) <= 2;
  }) || null;
}

/**
 * שורה אוטומטית אחרת (איזי קאונט / סאמיט) על אותו מסמך = סכנת כפל ספירה.
 * לא ממזגים ולא מוחקים — השורות האלה "לא נוגעים בהן לעולם" (ezcount-webhook)
 * וגם המערכות האלה קפואות. מחזירים אותה כדי לדווח עליה ולדלג.
 */
export function pickAutomatedClash(candidates, row) {
  return (candidates || []).find((r) => {
    if (!r || r.id === row.id) return false;
    if (!String(r.id).startsWith('ezcount-') && !String(r.id).startsWith('sumit-')) return false;
    if (r.entity && r.entity !== row.entity) return false;
    const a = Math.abs(Number(r.amount) || 0), b = Math.abs(row.amount) || 0;
    if (!a || !b) return false;
    return Math.abs(a - b) <= 2 || Math.abs(a * 1.18 - b) <= 2;
  }) || null;
}

/**
 * ירושה מהשורה הידנית — אותם שדות בדיוק כמו ב-ezcount-webhook: השיוך
 * לפרויקט, ההגשה לעירייה, שרשרת הסגירה, דגל התזרים, וסטטוס "שולם" אם כבר
 * סומן. השורה הידנית נמחקת אחר כך (באחריות הקורא).
 */
export function inheritFromManual(row, manual) {
  const merged = {
    ...row,
    project_id: manual.project_id ?? null,
    submitted_to_muni: manual.submitted_to_muni ?? false,
    muni_submit_date: manual.muni_submit_date ?? null,
    closes_id: manual.closes_id ?? null,
    exclude_cashflow: manual.exclude_cashflow ?? false,
  };
  if (manual.status === 'paid') {
    merged.status = 'paid';
    merged.date_paid = manual.date_paid ?? row.date_paid ?? row.date_sent ?? null;
  }
  return merged;
}

/**
 * התאריך שממנו מושכים בריצה רגילה: סימן המים פחות חלון חפיפה.
 * למה חפיפה: הרשימה ממוינת לפי created_at, ומסמך שנוצר שנייה לפני שהריצה
 * הקודמת קראה עלול להיכתב למסד אחרי שהיא כבר עברה את הנקודה. הכתיבה
 * אידמפוטנטית ולכן חפיפה היא זולה — דילוג הוא לא.
 */
export function sinceWithOverlap(lastCreatedAt, overlapMinutes) {
  if (!lastCreatedAt) return null;
  const t = new Date(lastCreatedAt).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t - (overlapMinutes || 0) * 60_000).toISOString();
}
