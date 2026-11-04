/**
 * בדיקות למיפוי מסמך → שורה בטבלה. נתונים סינתטיים בלבד — אין כאן שום
 * לקוח אמיתי ואין גישה למסד. הרצה:  node --test test/
 *
 * למה דווקא הפונקציות האלה: הן היחידות שמחליטות כמה כסף נרשם, באיזו ישות
 * ובאיזה סימן — טעות בהן שקטה ומופיעה רק בדוח לרו"ח.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapDocument, agorotToShekels, changedFields, pickManualDuplicate,
  pickAutomatedClash, inheritFromManual, sinceWithOverlap, SKIP_TYPES,
  isIntercompany, INTERCO_PREFIX, isSettled, paidDate, linkOf, compatibleLabels,
  pickHistoricalTarget, planLink, needsRecheck,
} from '../supabase/functions/invoices-sync/mapping.js';

const OSEK = '11111111-1111-1111-1111-111111111111';
const CHEVRA = '22222222-2222-2222-2222-222222222222';
const MAP = { [OSEK]: 'עוסק', [CHEVRA]: 'חברה' };
const BASE = 'https://invoices.example.test';

const doc = (over = {}) => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  entity_id: OSEK,
  doc_type: 'tax_invoice',
  doc_number: 1001,
  issue_date: '2026-09-20',
  client_snapshot: { name: 'לקוח לדוגמה' },
  total_agorot: 118000,
  created_at: '2026-09-20T09:00:00.000Z',
  ...over,
});

test('אגורות → שקלים', () => {
  assert.equal(agorotToShekels(118000), 1180);
  assert.equal(agorotToShekels(1), 0.01);
  assert.equal(agorotToShekels(0), 0);
});

test('חשבונית מס של העוסק — שורה מלאה בשקלים כולל מע"מ', () => {
  const { row } = mapDocument(doc(), MAP, BASE);
  assert.equal(row.id, 'arz-aaaaaaaa-0000-0000-0000-000000000001');
  assert.equal(row.invoice_number, '1001');
  assert.equal(row.invoice_type, 'חשבונית מס');
  assert.equal(row.amount, 1180);
  assert.equal(row.entity, 'עוסק');
  assert.equal(row.date_sent, '2026-09-20');
  assert.equal(row.status, 'sent');
  assert.equal(row.file_url, `${BASE}/api/v1/documents/${doc().id}/pdf`);
});

test('ישות החברה מזוהה לפי ה-uuid', () => {
  const { row } = mapDocument(doc({ entity_id: CHEVRA }), MAP, BASE);
  assert.equal(row.entity, 'חברה');
});

test('ישות לא מוכרת — לא מנחשים, מדלגים', () => {
  const m = mapDocument(doc({ entity_id: '99999999-9999-9999-9999-999999999999' }), MAP, BASE);
  assert.equal(m.skip, 'unknown_entity');
  assert.equal(m.row, null);
});

test('חשבונית זיכוי נשמרת בסימן שלילי', () => {
  const { row } = mapDocument(doc({ doc_type: 'credit_note', total_agorot: 59000 }), MAP, BASE);
  assert.equal(row.invoice_type, 'חשבונית זיכוי');
  assert.equal(row.amount, -590);
});

test('חשבון עסקה וחשבונית מס-קבלה — השמות של טבלת הניהול', () => {
  assert.equal(mapDocument(doc({ doc_type: 'proforma' }), MAP, BASE).row.invoice_type, 'חשבון עסקה');
  const tir = mapDocument(doc({ doc_type: 'tax_invoice_receipt' }), MAP, BASE).row;
  assert.equal(tir.invoice_type, 'חשבונית מס קבלה');   // בלי מקף — כמו ב-ezcount-webhook
  assert.equal(tir.status, 'paid');                     // המסמך הוא התקבול עצמו
  assert.equal(tir.date_paid, '2026-09-20');
});

test('הצעת מחיר והזמנה לא נכנסות לטבלה (כמו ב-webhook)', () => {
  for (const t of ['quote', 'work_order', 'purchase_order', 'delivery_note']) {
    assert.equal(mapDocument(doc({ doc_type: t }), MAP, BASE).skip, 'type:' + t);
    assert.ok(SKIP_TYPES.includes(t));
  }
});

test('סוג לא מוכר — מדווח, לא נכתב', () => {
  assert.equal(mapDocument(doc({ doc_type: 'something_new' }), MAP, BASE).skip, 'unknown_type:something_new');
});

test('ריצה חוזרת על אותו מסמך לא מייצרת שינוי', () => {
  const { row } = mapDocument(doc(), MAP, BASE);
  // מה שכבר יושב בטבלה, כולל עבודה ידנית שמשה עשה מאז
  const existing = { ...row, status: 'paid', date_paid: '2026-09-25', project_id: 'abc', notes: 'משהו אחר' };
  assert.deepEqual(changedFields(existing, row), []);
});

test('שינוי אמיתי בסכום מזוהה, שינוי של אגורה בודדת לא נבלע', () => {
  const { row } = mapDocument(doc(), MAP, BASE);
  assert.deepEqual(changedFields({ ...row, amount: 1180.0 }, row), []);
  assert.deepEqual(changedFields({ ...row, amount: 1180.01 }, row), ['amount']);
  assert.deepEqual(changedFields({ ...row, date_sent: '2026-01-01' }, row), ['date_sent']);
});

test('מיזוג עם שורה ידנית שנרשמה ללא מע"מ', () => {
  const { row } = mapDocument(doc(), MAP, BASE);
  const manual = {
    id: 'k3n1x9', invoice_number: '1001', amount: 1000, entity: 'עוסק',   // 1000 × 1.18 = 1180
    project_id: 'proj-7', submitted_to_muni: true, muni_submit_date: '2026-09-01',
    status: 'paid', date_paid: '2026-09-18', closes_id: null, exclude_cashflow: false,
  };
  const hit = pickManualDuplicate([manual], row);
  assert.equal(hit.id, 'k3n1x9');
  const merged = inheritFromManual(row, hit);
  assert.equal(merged.project_id, 'proj-7');
  assert.equal(merged.submitted_to_muni, true);
  assert.equal(merged.status, 'paid');
  assert.equal(merged.date_paid, '2026-09-18');
  assert.equal(merged.amount, 1180);                 // הסכום נשאר של המסמך הרשמי
});

test('שורה ידנית של ישות אחרת עם אותו מספר — לא ממזגים', () => {
  const { row } = mapDocument(doc({ entity_id: CHEVRA }), MAP, BASE);
  const manual = { id: 'k3n1x9', invoice_number: '1001', amount: 1180, entity: 'עוסק' };
  assert.equal(pickManualDuplicate([manual], row), null);
});

test('שורות אוטומטיות אחרות לא נבחרות למיזוג — אלא מדווחות כהתנגשות', () => {
  const { row } = mapDocument(doc(), MAP, BASE);
  const ez = { id: 'ezcount-xyz', invoice_number: '1001', amount: 1180, entity: 'עוסק' };
  assert.equal(pickManualDuplicate([ez], row), null);
  assert.equal(pickAutomatedClash([ez], row).id, 'ezcount-xyz');
  // והשורה שלנו עצמה אף פעם לא "מתנגשת" עם עצמה
  assert.equal(pickAutomatedClash([{ ...row }], row), null);
});

test('חלון החפיפה מזיז את סימן המים אחורה', () => {
  assert.equal(sinceWithOverlap('2026-09-20T10:00:00.000Z', 10), '2026-09-20T09:50:00.000Z');
  assert.equal(sinceWithOverlap(null, 10), null);
  assert.equal(sinceWithOverlap('לא תאריך', 10), null);
});

/* ══════════════ 11.10.26 — דרישת תשלום, בין-חברתי, החרגה, קישורים ══════════════ */

test('דרישת תשלום — סוג משלה בטבלה, נשלחת וממתינה', () => {
  const { row, skip } = mapDocument(doc({ doc_type: 'payment_request', doc_number: 1007 }), MAP, BASE);
  assert.equal(skip, null);
  assert.equal(row.invoice_type, 'דרישת תשלום');
  assert.equal(row.status, 'sent');
  assert.equal(row.exclude_cashflow, false);
});

test('מסמך בין-חברתי — נכנס, מסומן, ומחוץ לכסף', () => {
  for (const taxId of ['201608239', '516081387', ' 516081387 ', '51-6081387']) {
    const d = doc({ entity_id: CHEVRA, doc_type: 'tax_invoice_receipt', client_snapshot: { name: 'ישות אחות', tax_id: taxId } });
    assert.equal(isIntercompany(d), true);
    const { row } = mapDocument(d, MAP, BASE);
    assert.equal(row.exclude_cashflow, true);
    assert.equal(row.notes, INTERCO_PREFIX + 'ישות אחות');
    assert.equal(row.amount, 1180);            // הסכום נשאר — רק הספירה מנוטרלת
  }
});

test('לקוח רגיל (או בלי ח.פ) אינו בין-חברתי', () => {
  for (const cs of [{ name: 'עירייה', tax_id: '500000001' }, { name: 'פרטי' }, { name: 'x', tax_id: '' }, { name: 'x', tax_id: null }]) {
    const { row } = mapDocument(doc({ client_snapshot: cs }), MAP, BASE);
    assert.equal(row.exclude_cashflow, false);
    assert.ok(!String(row.notes).startsWith(INTERCO_PREFIX));
  }
});

test('מיזוג עם שורה ידנית לא מבטל את הסימון הבין-חברתי', () => {
  const { row } = mapDocument(doc({ client_snapshot: { name: 'אחות', tax_id: '201608239' } }), MAP, BASE);
  const merged = inheritFromManual(row, { id: 'm1', exclude_cashflow: false, status: 'sent' });
  assert.equal(merged.exclude_cashflow, true);
  // ולהיפך: דגל ידני נשמר על מסמך רגיל
  const plain = mapDocument(doc(), MAP, BASE).row;
  assert.equal(inheritFromManual(plain, { id: 'm1', exclude_cashflow: true }).exclude_cashflow, true);
});

test('רשימת ההחרגה: מסמך הבדיקה של ₪1 לא נכנס — ורק הוא', () => {
  const t = { entity_id: CHEVRA, doc_type: 'tax_invoice_receipt', doc_number: 30344, total_agorot: 100 };
  assert.equal(mapDocument(doc(t), MAP, BASE).skip, 'excluded_doc');
  assert.equal(mapDocument(doc({ ...t, doc_number: 30345 }), MAP, BASE).skip, null);
  assert.equal(mapDocument(doc({ ...t, entity_id: OSEK }), MAP, BASE).skip, null);        // אותו מספר בעוסק
  assert.equal(mapDocument(doc({ ...t, doc_type: 'tax_invoice' }), MAP, BASE).skip, null); // אותו מספר בסדרה אחרת
});

test('payment_state מה-API המעודכן: חוב ששולם במלואו נכנס כבר כ"שולם"', () => {
  const paid = mapDocument(doc({ payment_state: { paid_agorot: 118000, paid_in_full: true, paid_at: '2026-10-06T21:30:00Z' } }), MAP, BASE).row;
  assert.equal(paid.status, 'paid');
  assert.equal(paid.date_paid, '2026-10-07');     // 21:30 UTC = אחרי חצות בישראל
  const part = mapDocument(doc({ payment_state: { paid_agorot: 50000, paid_in_full: false } }), MAP, BASE).row;
  assert.equal(part.status, 'sent');
  assert.equal(mapDocument(doc(), MAP, BASE).row.status, 'sent');   // API ישן: אין payment_state
  assert.equal(mapDocument(doc({ payment_state: null }), MAP, BASE).row.status, 'sent');
});

test('isSettled / paidDate — גם בצורה של ה-API הישן (בלי paid_in_full)', () => {
  assert.equal(isSettled(1000, { paid_agorot: 1000 }), true);
  assert.equal(isSettled(1000, { paid_agorot: 999 }), false);
  assert.equal(isSettled(0, { paid_agorot: 0 }), false);
  assert.equal(isSettled(1000, undefined), false);
  assert.equal(isSettled(1000, { paid_agorot: 1000, paid_in_full: false }), false);   // הדגל המפורש גובר
  assert.equal(paidDate(null, '2026-10-11'), '2026-10-11');
  assert.equal(paidDate({ paid_at: 'זבל' }, '2026-10-11'), '2026-10-11');
  assert.equal(paidDate({ paid_at: '2026-10-06T09:08:00Z' }, 'x'), '2026-10-06');
});

test('linkOf — מהרשימה (API מעודכן) או מהמסמך הבודד (API ישן); לא ידוע ≠ אין', () => {
  const fromList = linkOf({ id: 'r', ref_document_id: 'i1', ref_historical_id: null, ref_document: { id: 'i1', total_agorot: 500 } }, null);
  assert.deepEqual([fromList.known, fromList.refDocId, fromList.refDoc.total_agorot], [true, 'i1', 500]);
  const none = linkOf({ id: 'r', ref_document_id: null, ref_historical_id: null }, null);
  assert.deepEqual([none.known, none.refDocId, none.refHistId], [true, null, null]);
  const old = linkOf({ id: 'r' }, { document: { id: 'r', ref_document_id: null, ref_historical_id: 'h1' } });
  assert.deepEqual([old.known, old.refHistId, old.refHist], [true, 'h1', null]);       // API ישן: בלי פרטי מסמך העבר
  const newDetail = linkOf({ id: 'r' }, { document: { id: 'r', ref_historical_id: 'h1' }, ref_historical: { doc_number: 10879 } });
  assert.equal(newDetail.refHist.doc_number, 10879);
  assert.equal(linkOf({ id: 'r' }, null).known, false);
});

const hist = (over = {}) => ({ id: 'h1', entity_id: OSEK, doc_type: 'tax_invoice', doc_number: 10879, total_agorot: 10193358, ...over });
const mg = (over = {}) => ({ id: 'ezcount-abc', invoice_number: '10879', invoice_type: 'חשבונית מס', amount: 101934, entity: 'עוסק', status: 'sent', ...over });

test('מסמך עבר → השורה שלו בטבלה: מספר + ישות + סוג + סכום (±₪2 או ×1.18)', () => {
  assert.equal(pickHistoricalTarget([mg()], hist(), 'עוסק').row.id, 'ezcount-abc');            // 101,934 מול 101,933.58
  assert.equal(pickHistoricalTarget([mg({ id: 'm1', amount: 86384.39 })], hist(), 'עוסק').row.id, 'm1');   // ידני בלי מע"מ
  assert.equal(pickHistoricalTarget([mg({ id: 'sumit-9' })], hist(), 'עוסק').row.id, 'sumit-9');
});

test('מסמך עבר — בלי התאמה בטוחה מדווחים ולא מנחשים', () => {
  const r = (c, h = hist(), e = 'עוסק') => pickHistoricalTarget(c, h, e);
  const no = (reason) => ({ row: null, reason, typeMismatch: false });
  assert.deepEqual(r([mg({ entity: 'חברה' })]), no('hist_no_match'));        // ישות אחרת
  assert.deepEqual(r([mg({ amount: 90000 })]), no('hist_no_match'));          // סכום אחר
  assert.deepEqual(r([mg({ invoice_type: 'קבלה' })]), no('hist_no_match'));   // קבלה/זיכוי אינם חוב
  assert.deepEqual(r([mg({ invoice_type: 'חשבונית זיכוי' })]), no('hist_no_match'));
  assert.deepEqual(r([mg({ invoice_number: '10880' })]), no('hist_no_match'));
  assert.deepEqual(r([mg({ status: 'cancelled' })]), no('hist_no_match'));
  assert.deepEqual(r([mg({ id: 'arz-x' })]), no('hist_no_match'));            // מסמך עבר אינו שורת arz-
  assert.deepEqual(r([mg({ entity: null })]), no('hist_no_match'));           // ישות חסרה — לא מניחים
  assert.deepEqual(r([mg(), mg({ id: 'm2' })]), no('hist_ambiguous'));        // שתי שורות זהות — לא בוחרים
  assert.deepEqual(r([mg()], hist({ doc_number: null })), no('hist_incomplete'));
  assert.deepEqual(r([mg()], hist({ doc_type: 'receipt' })), no('hist_incomplete'));
  assert.deepEqual(r([], hist()), no('hist_no_match'));
});

test('מסמך עבר שתויג בטבלה בסוג שגוי: מזוהה לפי מספר+ישות+סכום, ומסומן typeMismatch', () => {
  // חשבונית מס 10889 שה-webhook הישן רשם כ"חשבון עסקה"
  const wrong = mg({ id: 'ezcount-w', invoice_number: '10889', invoice_type: 'חשבון עסקה', amount: 155417.32 });
  const h = hist({ doc_number: 10889, total_agorot: 15541732 });
  const hit = pickHistoricalTarget([wrong], h, 'עוסק');
  assert.equal(hit.row.id, 'ezcount-w'); assert.equal(hit.typeMismatch, true);
  assert.equal(pickHistoricalTarget([mg()], hist(), 'עוסק').typeMismatch, false);
  // שתי שורות עם אותו מספר וסכום — הסוג שובר שוויון
  const right = { ...wrong, id: 'ezcount-r', invoice_type: 'חשבונית מס' };
  const tie = pickHistoricalTarget([wrong, right], h, 'עוסק');
  assert.equal(tie.row.id, 'ezcount-r'); assert.equal(tie.typeMismatch, false);
});

test('סוגים תואמים: חשבון עסקה היסטורי מול שורת חשבון עסקה; מס מול מס/מס-קבלה', () => {
  assert.deepEqual(compatibleLabels('tax_invoice'), ['חשבונית מס', 'חשבונית מס קבלה']);
  assert.deepEqual(compatibleLabels('proforma'), ['חשבון עסקה']);
  assert.ok(compatibleLabels('other').includes('חשבון עסקה'));
  assert.deepEqual(compatibleLabels('credit_note'), []);
  const pf = pickHistoricalTarget([mg({ invoice_type: 'חשבון עסקה', id: 'm9' })], hist({ doc_type: 'proforma' }), 'עוסק');
  assert.equal(pf.row.id, 'm9');
});

test('קבלה מלאה מסמנת את החשבונית כשולמה, בתאריך הקבלה', () => {
  const receipt = doc({ doc_type: 'receipt', total_agorot: 10193358, issue_date: '2026-10-06' });
  const p = planLink(receipt, mg(), 101933.58);
  assert.deepEqual(p, { targetPatch: { status: 'paid', date_paid: '2026-10-06' }, closesId: null, report: null });
  // סבילות ₪2 כלפי מטה
  assert.ok(planLink(doc({ doc_type: 'receipt', total_agorot: 10193200 }), mg(), 101933.58).targetPatch);
});

test('קבלה חלקית — מדווחת, לא מסמנת; יעד ששולם/בוטל/אינו חוב — לא נוגעים', () => {
  const half = doc({ doc_type: 'receipt', total_agorot: 5000000 });
  assert.deepEqual(planLink(half, mg(), 101933.58), { targetPatch: null, closesId: null, report: 'partial_receipt' });
  const full = doc({ doc_type: 'receipt', total_agorot: 10193358 });
  assert.equal(planLink(full, mg({ status: 'paid' }), 101933.58).targetPatch, null);
  assert.equal(planLink(full, mg({ status: 'cancelled' }), 101933.58).targetPatch, null);
  assert.deepEqual(planLink(full, mg({ invoice_type: 'חשבונית זיכוי' }), 101933.58), { targetPatch: null, closesId: null, report: 'target_not_debt' });
  // 'חשבונית מס קבלה' שנשארה sent בטבלה (תיוג שגוי ישן) — נסגרת
  assert.deepEqual(planLink(full, mg({ invoice_type: 'חשבונית מס קבלה' }), 101933.58).targetPatch, { status: 'paid', date_paid: '2026-09-20' });
  assert.equal(planLink(full, mg(), 0).report, 'target_amount_unknown');
  assert.deepEqual(planLink(full, null, 0), { targetPatch: null, closesId: null, report: null });
});

test('קבלה על חשבון עסקה מסמנת אותו כשולם (הטבלה תדרוש אז חשבונית מס)', () => {
  const p = planLink(doc({ doc_type: 'receipt', total_agorot: 118000, issue_date: '2026-10-01' }), mg({ invoice_type: 'חשבון עסקה' }), 1180);
  assert.deepEqual(p.targetPatch, { status: 'paid', date_paid: '2026-10-01' });
});

test('חשבונית מס / מס-קבלה על חשבון עסקה ⇒ closes_id, בלי לגעת בסטטוס של העסקה', () => {
  for (const t of ['tax_invoice', 'tax_invoice_receipt']) {
    const p = planLink(doc({ doc_type: t }), mg({ id: 'arz-pf', invoice_type: 'חשבון עסקה' }), 1180);
    assert.deepEqual(p, { targetPatch: null, closesId: 'arz-pf', report: null });
  }
  assert.equal(planLink(doc({ doc_type: 'tax_invoice' }), mg({ id: 'arz-pr', invoice_type: 'דרישת תשלום' }), 1180).closesId, 'arz-pr');
  // חשבונית מס שמפנה לחשבונית מס אחרת / זיכוי — אין שרשרת
  assert.equal(planLink(doc({ doc_type: 'tax_invoice' }), mg(), 1180).closesId, null);
  assert.deepEqual(planLink(doc({ doc_type: 'credit_note' }), mg(), 1180), { targetPatch: null, closesId: null, report: null });
});

test('בדיקה חוזרת — רק שורות arz- של חוב שעדיין sent', () => {
  assert.equal(needsRecheck({ id: 'arz-1', status: 'sent', invoice_type: 'חשבונית מס' }), true);
  assert.equal(needsRecheck({ id: 'arz-1', status: 'sent', invoice_type: 'דרישת תשלום' }), true);
  assert.equal(needsRecheck({ id: 'arz-1', status: 'paid', invoice_type: 'חשבונית מס' }), false);
  assert.equal(needsRecheck({ id: 'arz-1', status: 'sent', invoice_type: 'חשבונית זיכוי' }), false);
  assert.equal(needsRecheck({ id: 'ezcount-1', status: 'sent', invoice_type: 'חשבונית מס' }), false);
});
