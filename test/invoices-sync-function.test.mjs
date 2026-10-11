/**
 * בדיקת הפונקציה עצמה (supabase/functions/invoices-sync/index.ts) מקצה לקצה,
 * בלי Deno, בלי רשת ובלי מסד: ה-API של מערכת החשבוניות וטבלת invoices מדומים
 * בזיכרון. נתונים סינתטיים בלבד.   הרצה:  node --test test/
 *
 * איך: מסירים את הטיפוסים מהקובץ (stripTypeScriptTypes של node), מחליפים את
 * שני ייבואי ה-jsr במדמים, וטוענים את התוצאה כמודול. הקוד שנבדק הוא הקוד
 * שנפרס — לא העתק שלו.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const FN_DIR = fileURLToPath(new URL('../supabase/functions/invoices-sync/', import.meta.url));
const OSEK = '11111111-1111-1111-1111-111111111111';
const CHEVRA = '22222222-2222-2222-2222-222222222222';
const KEY = 'test-sync-key';
const u = (n) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;

/* ── טבלה מדומה: רק מה שהפונקציה משתמשת בו מ-supabase-js ── */
function fakeDb(tables) {
  const from = (name) => {
    const t = (tables[name] ??= []);
    const filters = []; let op = 'select', payload = null, lim = null, order = null;
    const match = (r) => filters.every((f) => f(r));
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return api; },
      like(c, pat) { const pre = pat.replace(/%$/, ''); filters.push((r) => String(r[c]).startsWith(pre)); return api; },
      not(c, o, v) { const vs = v.replace(/[()]/g, '').split(','); filters.push((r) => !vs.includes(String(r[c]))); return api; },
      order(c, o) { order = [c, o?.ascending !== false]; return api; },
      limit(n) { lim = n; return api; },
      maybeSingle() { return Promise.resolve({ data: t.filter(match)[0] ?? null, error: null }); },
      update(p) { op = 'update'; payload = p; return api; },
      delete() { op = 'delete'; return api; },
      upsert(p, opts) {
        const key = opts?.onConflict ?? 'id';
        for (const row of Array.isArray(p) ? p : [p]) {
          const i = t.findIndex((r) => r[key] === row[key]);
          if (i >= 0) t[i] = { ...t[i], ...row }; else t.push({ ...row });
        }
        return Promise.resolve({ error: null });
      },
      then(res, rej) {
        let out;
        if (op === 'update') { t.filter(match).forEach((r) => Object.assign(r, payload)); out = { error: null }; }
        else if (op === 'delete') { for (let i = t.length - 1; i >= 0; i--) if (match(t[i])) t.splice(i, 1); out = { error: null }; }
        else {
          let rows = t.filter(match);
          if (order) rows = [...rows].sort((a, b) => (String(a[order[0]]) < String(b[order[0]]) ? -1 : 1) * (order[1] ? 1 : -1));
          out = { data: lim ? rows.slice(0, lim) : rows, error: null };
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return api;
  };
  return { from };
}

/* ── API מדומה של מערכת החשבוניות. mode: 'new' (עם שדות הקישור) / 'old' (בלי) ── */
function fakeApi({ docs, states = {}, hist = {}, mode }) {
  const calls = [];
  const sorted = () => [...docs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const ps = (d) => (['tax_invoice', 'proforma', 'payment_request'].includes(d.doc_type)
    ? { paid_agorot: states[d.id] ?? 0, open_agorot: Math.max(0, d.total_agorot - (states[d.id] ?? 0)),
        ...(mode === 'new' ? { paid_in_full: (states[d.id] ?? 0) >= d.total_agorot, paid_at: states[d.id] ? '2026-10-08T08:00:00Z' : null } : {}) }
    : null);
  const refDoc = (id) => { const d = docs.find((x) => x.id === id); return d ? { id, entity_id: d.entity_id, doc_type: d.doc_type, doc_number: d.doc_number, total_agorot: d.total_agorot } : null; };
  const listRow = (d) => {
    const base = { id: d.id, entity_id: d.entity_id, doc_type: d.doc_type, doc_number: d.doc_number, issue_date: d.issue_date,
      client_snapshot: d.client_snapshot, total_agorot: d.total_agorot, created_at: d.created_at };
    if (mode === 'old') return base;
    return { ...base, ref_document_id: d.ref_document_id ?? null, ref_historical_id: d.ref_historical_id ?? null,
      ref_document: d.ref_document_id ? refDoc(d.ref_document_id) : null, ref_historical: d.ref_historical_id ? hist[d.ref_historical_id] ?? null : null,
      payment_state: ps(d) };
  };
  const fetchFn = async (url, init) => {
    const uo = new URL(url); calls.push(uo.pathname + uo.search);
    assert.equal(init.headers.Authorization, 'Bearer ak_test');
    const m = uo.pathname.match(/\/api\/v1\/documents\/([0-9a-f-]{36})$/);
    let body;
    if (m) {
      const d = docs.find((x) => x.id === m[1]);
      if (!d) return new Response('{}', { status: 404 });
      body = { document: { ...d }, payment_state: ps(d) ?? { paid_agorot: 0, open_agorot: 0 },
        ...(mode === 'new' ? { ref_document: d.ref_document_id ? refDoc(d.ref_document_id) : null, ref_historical: d.ref_historical_id ? hist[d.ref_historical_id] ?? null : null } : {}) };
    } else {
      let list = sorted();
      const from = uo.searchParams.get('from'); if (from) list = list.filter((d) => d.issue_date >= from);
      const ids = uo.searchParams.get('ids'); if (ids && mode === 'new') list = list.filter((d) => ids.split(',').includes(d.id));
      body = { documents: list.map(listRow), next_cursor: null };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchFn, calls };
}

/* ── טעינת הפונקציה ── */
let handler = null, currentDb = null;
async function loadHandler() {
  if (handler) return handler;
  let src = readFileSync(join(FN_DIR, 'index.ts'), 'utf8');
  src = stripTypeScriptTypes(src)
    .replace(/import "jsr:@supabase\/functions-js\/edge-runtime\.d\.ts";/, '')
    .replace(/import \{ createClient \} from "jsr:@supabase\/supabase-js@2";/, 'const createClient = () => globalThis.__syncTestDb();')
    .replace('"./mapping.js"', JSON.stringify(pathToFileURL(join(FN_DIR, 'mapping.js')).href));
  assert.ok(!src.includes('jsr:'), 'נשאר ייבוא jsr שלא הוחלף');
  globalThis.__syncTestDb = () => currentDb;
  globalThis.Deno = {
    env: { get: (k) => ({ INVOICES_API_KEY: 'ak_test', INVOICES_API_BASE: 'https://inv.test', INVOICES_SYNC_KEY: KEY,
      INVOICES_ENTITY_MAP: JSON.stringify({ [OSEK]: 'עוסק', [CHEVRA]: 'חברה' }), SUPABASE_URL: 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' }[k]) },
    serve: (h) => { handler = h; },
  };
  const file = join(mkdtempSync(join(tmpdir(), 'invsync-')), 'index.mjs');
  writeFileSync(file, src);
  await import(pathToFileURL(file).href);
  return handler;
}
async function run({ tables, api, query = '', key = KEY }) {
  const h = await loadHandler();
  currentDb = fakeDb(tables);
  const realFetch = globalThis.fetch; globalThis.fetch = api.fetchFn;
  try {
    const res = await h(new Request('https://fn.test/invoices-sync' + query, { method: 'POST', headers: key ? { 'x-sync-key': key } : {} }));
    return { status: res.status, out: await res.json() };
  } finally { globalThis.fetch = realFetch; }
}
const byNum = (tables, n) => tables.invoices.filter((r) => r.invoice_number === String(n));

/* ── תרחיש: דומה למה שקרה בפועל מאז 22.9, בנתונים סינתטיים ── */
const doc = (n, over) => ({ id: u(n), entity_id: OSEK, doc_type: 'tax_invoice', doc_number: 10000 + n, issue_date: '2026-09-30',
  client_snapshot: { name: 'לקוח ' + n, tax_id: '500000001' }, total_agorot: 118000, created_at: `2026-10-05T10:${String(n).padStart(2, '0')}:00+00:00`, ...over });
function scenario() {
  const docs = [
    doc(1, { entity_id: CHEVRA, doc_type: 'tax_invoice_receipt', doc_number: 30344, total_agorot: 100 }),          // מסמך בדיקה — מוחרג
    doc(2, { doc_number: 10891 }),                                                                              // חשבונית מס, תיסגר בקבלה 6
    doc(3, { doc_number: 10892, total_agorot: 200000 }),                                                        // חשבונית מס, קבלה חלקית 7
    doc(4, { entity_id: CHEVRA, doc_type: 'proforma', doc_number: 40029, total_agorot: 353056 }),               // קיים ידנית (draft) ⇒ מיזוג
    doc(5, { entity_id: CHEVRA, doc_type: 'payment_request', doc_number: 1007, total_agorot: 353056 }),
    doc(6, { doc_type: 'receipt', doc_number: 20250, issue_date: '2026-10-06', ref_document_id: u(2) }),
    doc(7, { doc_type: 'receipt', doc_number: 20251, issue_date: '2026-10-06', total_agorot: 50000, ref_document_id: u(3) }),
    doc(8, { doc_type: 'receipt', doc_number: 20241, issue_date: '2026-10-06', total_agorot: 10193358, ref_historical_id: 'h-10879' }),
    doc(9, { doc_type: 'receipt', doc_number: 20242, issue_date: '2026-10-06', total_agorot: 700000, ref_historical_id: 'h-none' }),
    doc(10, { entity_id: CHEVRA, doc_type: 'tax_invoice_receipt', doc_number: 30346, client_snapshot: { name: 'ישות אחות', tax_id: '201608239' } }),
    doc(11, { entity_id: CHEVRA, doc_type: 'tax_invoice', doc_number: 10050, total_agorot: 353056, ref_document_id: u(4) }),  // סוגרת את חשבון העסקה 40029
    doc(12, { entity_id: CHEVRA, doc_type: 'quote', doc_number: 1016 }),
  ];
  const hist = {
    'h-10879': { id: 'h-10879', entity_id: OSEK, source: 'ezcount', doc_type: 'tax_invoice', doc_number: 10879, total_agorot: 10193358 },
    'h-none': { id: 'h-none', entity_id: OSEK, source: 'ezcount', doc_type: 'tax_invoice', doc_number: 10555, total_agorot: 700000 },
  };
  const tables = { invoices: [
    { id: 'ezcount-old1', invoice_number: '10879', invoice_type: 'חשבונית מס', amount: 101934, entity: 'עוסק', status: 'sent', date_paid: null, project_id: 'p-salary', closes_id: null, exclude_cashflow: false },
    { id: 'manual40029', invoice_number: '40029', invoice_type: 'חשבון עסקה', amount: 3530.56, entity: 'חברה', status: 'draft', date_paid: null, project_id: 'p-acoustics', closes_id: null, exclude_cashflow: false },
    { id: 'manual-other', invoice_number: '90001', invoice_type: 'חשבונית מס', amount: 500, entity: 'עוסק', status: 'sent', date_paid: null, project_id: null, closes_id: null, exclude_cashflow: false },
  ], sync_state: [] };
  return { docs, hist, tables };
}

test('בלי הסוד המשותף — 401, ושום קריאה לא יוצאת', async () => {
  const s = scenario(); const api = fakeApi({ ...s, mode: 'new' });
  for (const key of [null, 'wrong']) {
    const r = await run({ tables: s.tables, api, key });
    assert.equal(r.status, 401);
  }
  assert.equal(api.calls.length, 0);
  assert.equal(s.tables.invoices.length, 3);
});

test('ריצה יבשה לא כותבת כלום — גם לא את סימן המים', async () => {
  const s = scenario(); const api = fakeApi({ ...s, mode: 'new' });
  const before = JSON.stringify(s.tables);
  const r = await run({ tables: s.tables, api, query: '?dry=1&from=2026-09-22' });
  assert.equal(r.status, 200); assert.equal(r.out.dry, true);
  assert.equal(JSON.stringify(s.tables), before);
  assert.equal(r.out.insert, 9); assert.equal(r.out.merge, 1);
});

for (const mode of ['new', 'old']) {
  test(`מילוי למפרע מול ה-API ה${mode === 'new' ? 'מעודכן' : 'ישן (לפני הפריסה במערכת החשבוניות)'}`, async () => {
    const s = scenario(); const api = fakeApi({ ...s, mode });
    const r = await run({ tables: s.tables, api, query: '?from=2026-09-22' });
    assert.equal(r.status, 200); assert.deepEqual(r.out.errors, []); assert.equal(r.out.ok, true);
    const T = s.tables;

    // דילוגים: הצעת מחיר + מסמך הבדיקה
    assert.deepEqual(r.out.skipped_by_reason, { excluded_doc: 1, 'type:quote': 1 });
    assert.equal(byNum(T, 30344).length, 0); assert.equal(byNum(T, 1016).length, 0);

    // דרישת תשלום — סוג משלה
    assert.equal(byNum(T, 1007)[0].invoice_type, 'דרישת תשלום');

    // בין-חברתי — בפנים, מסומן, מחוץ לכסף
    const ic = byNum(T, 30346)[0];
    assert.equal(ic.exclude_cashflow, true); assert.ok(ic.notes.startsWith('בין-חברתי · '));
    assert.equal(byNum(T, 10891)[0].exclude_cashflow, false);

    // מיזוג עם השורה הידנית: נמחקה, והשיוך לפרויקט עבר
    assert.equal(T.invoices.some((x) => x.id === 'manual40029'), false);
    const pf = byNum(T, 40029); assert.equal(pf.length, 1);
    assert.equal(pf[0].id, 'arz-' + u(4)); assert.equal(pf[0].project_id, 'p-acoustics');

    // קבלה מלאה ⇒ החשבונית שולמה בתאריך הקבלה; הקבלה עצמה בטבלה
    const inv = byNum(T, 10891)[0];
    assert.equal(inv.status, 'paid'); assert.equal(inv.date_paid, '2026-10-06');
    assert.equal(byNum(T, 20250)[0].invoice_type, 'קבלה');

    // קבלה חלקית ⇒ החשבונית נשארת פתוחה, ומדווח
    assert.equal(byNum(T, 10892)[0].status, 'sent');
    assert.ok(r.out.report_list.some((x) => x.reason.startsWith('partial_receipt') && x.doc.includes('20251')));

    // closes_id: חשבונית מס על חשבון עסקה (לא תלוי בגרסת ה-API — ref_document_id קיים גם בישן)
    assert.equal(byNum(T, 10050)[0].closes_id, 'arz-' + u(4));
    assert.equal(pf[0].status, 'sent');           // חשבון העסקה עצמו לא מסומן שולם

    const old = T.invoices.find((x) => x.id === 'ezcount-old1');
    if (mode === 'new') {
      // קבלה על חשבונית ממערכת קודמת ⇒ שורת איזי קאונט הישנה מסומנת שולם
      assert.equal(old.status, 'paid'); assert.equal(old.date_paid, '2026-10-06');
      assert.equal(old.project_id, 'p-salary');   // שום דבר אחר לא נדרס
      // מסמך עבר שאין לו שורה בטבלה ⇒ מדווח, לא מנחשים
      assert.ok(r.out.report_list.some((x) => x.reason.startsWith('hist_no_match') && x.doc.includes('20242')));
      assert.equal(r.out.recheck.mode, 'none');   // לפני הכתיבה אין עדיין שורות arz- במסד
      assert.equal(r.out.detail_calls, 0);
    } else {
      // ה-API הישן לא מחזיר את פרטי מסמך העבר ⇒ מדווח, לא נוגעים
      assert.equal(old.status, 'sent');
      assert.equal(r.out.report_list.filter((x) => x.reason === 'historical_ref_needs_api_update').length, 2);
      assert.ok(r.out.detail_calls > 0);
    }
    assert.equal(T.invoices.find((x) => x.id === 'manual-other').status, 'sent');   // שורה לא קשורה — לא נגעו

    // סימן המים התקדם
    assert.equal(T.sync_state.length, 1); assert.ok(T.sync_state[0].last_created_at);

    // ── ריצה שנייה: אידמפוטנטית ──
    const snap = JSON.stringify(T.invoices.map(({ updated_at, ...x }) => x));
    const r2 = await run({ tables: T, api, query: '?from=2026-09-22' });
    assert.equal(r2.out.insert, 0); assert.equal(r2.out.merge, 0); assert.equal(r2.out.update, 0);
    assert.equal(r2.out.linked_paid, 0); assert.equal(r2.out.linked_closes, 0);
    assert.equal(JSON.stringify(T.invoices.map(({ updated_at, ...x }) => x)), snap);
    assert.equal(r2.out.recheck.mode, mode === 'new' ? 'bulk' : 'detail');
    assert.ok(r2.out.recheck.checked >= 2);       // 10892, 40029, 1007 עדיין פתוחות

    // ── התשלום החלקי הושלם במערכת החשבוניות ⇒ הבדיקה החוזרת מסמנת שולם ──
    const api3 = fakeApi({ ...s, mode, states: { [u(3)]: 200000 } });
    const r3 = await run({ tables: T, api: api3 });          // ריצה רגילה, מסימן המים
    assert.equal(r3.out.insert, 0); assert.equal(r3.out.reached_watermark, true);   // רק חלון החפיפה נסרק שוב
    assert.equal(r3.out.recheck.marked, 1);
    const late = byNum(T, 10892)[0];
    assert.equal(late.status, 'paid'); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(late.date_paid));
    if (mode === 'new') assert.equal(late.date_paid, '2026-10-08');   // paid_at מה-API
  });
}

test('אחרי פריסת ה-API המעודכן: ריצה חוזרת פותרת קבלות על מסמכי עבר שדווחו קודם', async () => {
  const s = scenario();
  await run({ tables: s.tables, api: fakeApi({ ...s, mode: 'old' }), query: '?from=2026-09-22' });
  assert.equal(s.tables.invoices.find((x) => x.id === 'ezcount-old1').status, 'sent');
  const r = await run({ tables: s.tables, api: fakeApi({ ...s, mode: 'new' }), query: '?from=2026-09-22' });
  assert.equal(r.out.insert, 0);
  const old = s.tables.invoices.find((x) => x.id === 'ezcount-old1');
  assert.equal(old.status, 'paid'); assert.equal(old.date_paid, '2026-10-06');
});

test('שורה ששולמה ידנית לא נדרסת: תאריך התשלום של משה נשאר', async () => {
  const s = scenario();
  s.tables.invoices[0] = { ...s.tables.invoices[0], status: 'paid', date_paid: '2026-10-01' };
  await run({ tables: s.tables, api: fakeApi({ ...s, mode: 'new' }), query: '?from=2026-09-22' });
  assert.equal(s.tables.invoices.find((x) => x.id === 'ezcount-old1').date_paid, '2026-10-01');
});

test('closes_id ידני גובר על הקישור מהמערכת', async () => {
  const s = scenario();
  const r1 = await run({ tables: s.tables, api: fakeApi({ ...s, mode: 'new' }), query: '?from=2026-09-22' });
  assert.equal(r1.out.ok, true);
  byNum(s.tables, 10050)[0].closes_id = 'manual-other';
  await run({ tables: s.tables, api: fakeApi({ ...s, mode: 'new' }), query: '?from=2026-09-22' });
  assert.equal(byNum(s.tables, 10050)[0].closes_id, 'manual-other');
});
