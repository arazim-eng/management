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
  // 11.10.26 (משה): סוג חדש במערכת החשבוניות (0044). נכנס לטבלה בשמו, אבל
  // **לא** נספר כצפי/תזרים — inCashflow ב-index.html מכיר רק מס/עסקה, וכך
  // דרישת תשלום שהופקה לצד חשבון עסקה על אותו סכום לא מכפילה את הצפי.
  payment_request: 'דרישת תשלום',
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

/**
 * מסמכים שלא נכנסים לטבלה לעולם — רשימה מפורשת וקצרה, לא כלל.
 * מפתח: `<ישות>|<doc_type>|<מספר>`.
 */
export const EXCLUDED_DOCS = [
  'חברה|tax_invoice_receipt|30344',   // ₪1, "בדיקת Grow" (27.9.26) — מסמך בדיקה של הסליקה
];

/**
 * מסמך בין-חברתי: הלקוח הוא אחת משתי הישויות של ארזים (החברה מחייבת את
 * העוסק או להיפך — מסמך מראה של חשבונית ללקוח האמיתי). 11.10.26 (משה):
 * נכנס לטבלה כדי שיראו אותו, אבל עם exclude_cashflow וסימון בהערות, ולעולם
 * לא נספר ככסף — אחרת אותה הכנסה נספרת פעמיים (פעם בכל ישות).
 */
export const INTERCO_TAX_IDS = ['201608239', '516081387'];
export const INTERCO_PREFIX = 'בין-חברתי · ';
export function isIntercompany(doc) {
  const taxId = String((doc && doc.client_snapshot && doc.client_snapshot.tax_id) || '').replace(/\D/g, '');
  return Boolean(taxId) && INTERCO_TAX_IDS.includes(taxId);
}

/** סוגים בטבלה שהם "חוב" — אפשר לסמן אותם כשולמו. */
export const TAX_LABELS = ['חשבונית מס', 'חשבונית מס קבלה'];
export const DEBT_LABELS = ['חשבונית מס', 'חשבון עסקה', 'דרישת תשלום'];
/** סוגי מסמך שלקישור שלהם (ref) יש השפעה על שורה אחרת בטבלה. */
export const LINK_TYPES = ['receipt', 'tax_invoice', 'tax_invoice_receipt'];
const TOLERANCE = 2;   // ₪ — אותה סבילות כמו במיזוג מול שורה ידנית

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
  if (EXCLUDED_DOCS.includes(`${entity}|${docType}|${doc.doc_number}`)) return drop('excluded_doc');

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
    // תמיד מפורש: העמודה NOT NULL, ושורות באותה אצווה חייבות אותם מפתחות
    exclude_cashflow: false,
  };
  if (isIntercompany(doc)) {
    row.exclude_cashflow = true;
    row.notes = INTERCO_PREFIX + (row.notes || '');
  }
  if (row.status === 'paid') row.date_paid = doc.issue_date || null;
  // חוב שכבר שולם במלואו במערכת החשבוניות (payment_state — קיים רק ב-API
  // המעודכן; בלעדיו השורה נכנסת 'sent' והבדיקה החוזרת תסמן אותה אחר כך).
  if (row.status === 'sent' && isSettled(doc.total_agorot, doc.payment_state)) {
    row.status = 'paid';
    row.date_paid = paidDate(doc.payment_state, doc.issue_date);
  }
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
    // בין-חברתי נשאר מחוץ לכסף גם אם השורה הידנית לא סומנה
    exclude_cashflow: Boolean(row.exclude_cashflow || manual.exclude_cashflow),
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

/* ══════════════ קישורים בין מסמכים ומצב תשלום (11.10.26) ══════════════
 * קבלה סוגרת חשבונית; חשבונית מס סוגרת חשבון עסקה. במערכת החשבוניות זה
 * ref_document_id (מסמך שלנו) או ref_historical_id (מסמך מסאמיט/איזי קאונט).
 * כאן רק ההחלטות — בלי רשת ובלי מסד. הכלל: התאמה בטוחה או דיווח, לא ניחוש.
 */

/** האם החוב כוסה במלואו לפי payment_state של ה-API (undefined ⇒ לא ידוע ⇒ false). */
export function isSettled(totalAgorot, ps) {
  if (!ps) return false;
  if (typeof ps.paid_in_full === 'boolean') return ps.paid_in_full;
  const total = Number(totalAgorot) || 0;   // ה-API הישן: רק paid_agorot
  return total > 0 && (Number(ps.paid_agorot) || 0) >= total;
}

/** תאריך התשלום: paid_at לפי שעון ישראל, ואם אין — ברירת המחדל שהועברה. */
export function paidDate(ps, fallback) {
  const t = ps && ps.paid_at ? new Date(ps.paid_at) : null;
  if (!t || Number.isNaN(t.getTime())) return fallback || null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(t);
}

/**
 * הקישור של מסמך, מנורמל. המקור: שורת הרשימה (API מעודכן) או, כשהשדות לא
 * קיימים בה (API ישן), התשובה של GET /documents/{id}.
 * ‏known=false ⇒ אין לנו דרך לדעת אם יש קישור (לא "אין קישור").
 */
export function linkOf(doc, detail) {
  const hasList = doc && Object.prototype.hasOwnProperty.call(doc, 'ref_document_id');
  const d = hasList ? doc : (detail && detail.document) || null;
  if (!d) return { known: false, refDocId: null, refDoc: null, refHistId: null, refHist: null };
  const side = hasList ? doc : detail;
  return {
    known: true,
    refDocId: d.ref_document_id || null,
    refDoc: (side && side.ref_document) || null,
    refHistId: d.ref_historical_id || null,
    refHist: (side && side.ref_historical) || null,
  };
}

/** סוג מסמך (שלנו או היסטורי) → אילו סוגים בטבלה יכולים להיות השורה שלו. */
export function compatibleLabels(docType) {
  if (docType === 'tax_invoice' || docType === 'tax_invoice_receipt') return TAX_LABELS;
  if (docType === 'proforma') return ['חשבון עסקה'];
  // דרישות תשלום של סאמיט יובאו כ-'other'; בטבלה הן נרשמו בזמנו כחשבון עסקה
  if (docType === 'payment_request' || docType === 'other') return ['דרישת תשלום', 'חשבון עסקה'];
  return [];
}

/**
 * השורה בטבלה של מסמך **היסטורי** (אין לו arz-, הוא הגיע מאיזי קאונט/סאמיט/
 * הקלדה). אותו כלל כמו במיזוג: אותו מספר, אותה ישות, סכום זהה או ×1.18 בסבילות
 * ₪2 — ורק שורה של חוב (לא קבלה/זיכוי). בדיוק התאמה אחת, אחרת מדווחים ולא בוחרים.
 *
 * הסוג **אינו** תנאי סף: בטבלה יש שורות שה-webhook של איזי קאונט תייג לא נכון
 * (חשבונית מס שרשומה כ"חשבון עסקה"), ומספר+ישות+סכום מזהים את המסמך בוודאות.
 * הסוג משמש רק לשבירת שוויון, ואי-התאמה חוזרת ב-typeMismatch כדי שתדווח.
 * @returns {{row: object|null, reason: string|null, typeMismatch: boolean}}
 */
export function pickHistoricalTarget(candidates, hist, entity) {
  const miss = (reason) => ({ row: null, reason, typeMismatch: false });
  const labels = compatibleLabels(String((hist && hist.doc_type) || ''));
  const gross = agorotToShekels(hist && hist.total_agorot);
  if (!hist || hist.doc_number == null || !labels.length || !gross) return miss('hist_incomplete');
  const debt = [...TAX_LABELS, ...DEBT_LABELS];
  let hits = (candidates || []).filter((r) => {
    if (!r || String(r.invoice_number) !== String(hist.doc_number)) return false;
    if (String(r.id).startsWith('arz-')) return false;
    if (r.entity !== entity) return false;
    if (r.status === 'cancelled') return false;
    if (!debt.includes(r.invoice_type)) return false;
    const a = Math.abs(Number(r.amount) || 0);
    if (!a) return false;
    return Math.abs(a - Math.abs(gross)) <= TOLERANCE || Math.abs(a * 1.18 - Math.abs(gross)) <= TOLERANCE;
  });
  const many = hits.length > 1;
  if (many) hits = hits.filter((r) => labels.includes(r.invoice_type));
  if (hits.length !== 1) return miss(many ? 'hist_ambiguous' : 'hist_no_match');
  return { row: hits[0], reason: null, typeMismatch: !labels.includes(hits[0].invoice_type) };
}

/**
 * מה הקישור של מסמך משנה בטבלה.
 * @param doc    המסמך מה-API
 * @param target השורה בטבלה של מסמך המקור (או null)
 * @param targetGross סכום מסמך המקור כולל מע"מ, בשקלים
 * @returns {{targetPatch: object|null, closesId: string|null, report: string|null}}
 *   targetPatch — לכתוב על שורת המקור; closesId — לכתוב על השורה של doc עצמו.
 */
export function planLink(doc, target, targetGross) {
  const none = { targetPatch: null, closesId: null, report: null };
  if (!target) return none;
  const type = String(doc.doc_type || '');
  if (type === 'receipt') {
    // קבלה: מסמנים את החוב שסגרה כשולם — רק כשהיא מכסה אותו במלואו.
    // גם 'חשבונית מס קבלה' שנשארה sent (תיוג שגוי של ה-webhook הישן) היא חוב שנסגר
    if (target.status === 'paid' || target.status === 'cancelled') return none;
    if (!DEBT_LABELS.includes(target.invoice_type) && !TAX_LABELS.includes(target.invoice_type)) return { ...none, report: 'target_not_debt' };
    const got = agorotToShekels(doc.total_agorot);
    const due = Math.abs(Number(targetGross) || 0);
    if (!due) return { ...none, report: 'target_amount_unknown' };
    if (got < due - TOLERANCE) return { ...none, report: 'partial_receipt' };
    return { targetPatch: { status: 'paid', date_paid: doc.issue_date || null }, closesId: null, report: null };
  }
  if (type === 'tax_invoice' || type === 'tax_invoice_receipt') {
    // חשבונית מס (או מס/קבלה) על חשבון עסקה / דרישת תשלום ⇒ שרשרת הסגירה
    if (target.invoice_type === 'חשבון עסקה' || target.invoice_type === 'דרישת תשלום') {
      return { targetPatch: null, closesId: String(target.id), report: null };
    }
  }
  return none;
}

/** האם שורה בטבלה היא חוב פתוח של מערכת החשבוניות שכדאי לבדוק אם שולם. */
export function needsRecheck(r) {
  return Boolean(r) && String(r.id).startsWith('arz-') && r.status === 'sent' && DEBT_LABELS.includes(r.invoice_type);
}
