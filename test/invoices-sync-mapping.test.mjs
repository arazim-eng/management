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
