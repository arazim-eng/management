// סנכרון חד-כיווני: מערכת החשבוניות (arazim-invoices) → טבלת החשבונות של הניהול.
//
// מ-22.9.26 מערכת החשבוניות היא המקום **היחיד** שמפיקים בו מסמכים (סאמיט
// ואיזי קאונט קפואים), ולכן טבלת הניהול חייבת להתמלא ממנה. הכיוון חד-כיווני:
// כאן רק קוראים מה-API של החשבוניות וכותבים לטבלת הניהול — לעולם לא להיפך.
//
// המקבילה הישנה היא supabase/functions/ezcount-webhook: שם המסמך נדחף אלינו
// פעם אחת, כאן אנחנו מושכים כל 15 דקות. כל מה שאפשר היה לשמר משם נשמר —
// צורת השורה, שמות הסוגים בעברית, הסכום כולל מע"מ, הזיכוי בסימן שלילי,
// ולוגיקת המיזוג מול שורה שנרשמה ידנית (ראו mapping.js, שם היא מרוכזת).
//
// ההבדל המהותי: webhook רץ פעם אחת, cron רץ שוב ושוב. לכן כאן יש שתי
// הגנות שאין שם — סימן מים (sync_state) שמונע סריקה מיותרת, ורשימת שדות
// שהסנכרון "בעלים" עליהם, כדי שריצה חוזרת לא תדרוס סטטוס "שולם", שיוך
// לפרויקט או הערות שמשה הזין ידנית.
//
// 11.10.26 — נוסף: דרישת תשלום, מסמכים בין-חברתיים (מחוץ לכסף), רשימת החרגה,
// קבלה שמסמנת את החשבונית שסגרה כשולמה, שרשרת closes_id, ובדיקה חוזרת של
// שורות arz- שעדיין 'sent'. ההחלטות עצמן ב-mapping.js (נבדקות ב-node).
//
// אימות: כותרת x-sync-key מול הסוד INVOICES_SYNC_KEY (כמו ezcount-webhook).
// הפונקציה כותבת עם service-role, ולכן verify_jwt כבוי ומפתח ה-anon הציבורי
// **לא** מספיק כדי להפעיל אותה.
//
// הפעלה:
//   POST/GET /functions/v1/invoices-sync            → ריצה רגילה (מסימן המים)
//   ...?dry=1                                       → מה **היה** נכתב, בלי לכתוב
//   ...?from=2026-09-01                             → מילוי למפרע לפי תאריך הפקה
//   ...?all=1                                       → כל ההיסטוריה (עד MAX_PAGES)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  mapDocument, changedFields, pickManualDuplicate, pickAutomatedClash,
  inheritFromManual, sinceWithOverlap,
  LINK_TYPES, DEBT_LABELS, linkOf, pickHistoricalTarget, planLink, isSettled, paidDate, agorotToShekels, needsRecheck,
} from "./mapping.js";

const SOURCE = "arazim-invoices";     // מפתח השורה ב-sync_state
const PAGE = 200;                     // תקרת ה-API
const MAX_PAGES = 25;                 // 5,000 מסמכים לריצה — גדר מפני timeout
const OVERLAP_MINUTES = 10;           // חפיפה לאחור, ראו sinceWithOverlap
const UPSERT_CHUNK = 100;
const DETAIL_CAP = 80;                // קריאות GET /documents/{id} לריצה (API ישן בלבד)
const RECHECK_LIMIT = 500;            // שורות arz- פתוחות שנבדקות בריצה
const RECHECK_DETAIL_CAP = 40;        // כנ"ל כשה-API הישן מחייב קריאה לכל מסמך
const IDS_CHUNK = 100;                // תקרת ?ids= ב-API

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

/** צורת ההחזרה של mapDocument (הקובץ עצמו JS כדי שאפשר יהיה לבדוק אותו ב-node) */
type Mapped = { skip: string | null; row: Record<string, unknown> | null; docType: string | null };

type PaymentState = { paid_agorot?: number; paid_in_full?: boolean; paid_at?: string | null } | null;
type RefDoc = { id: string; entity_id: string; doc_type: string; doc_number: number | string; total_agorot: number | string };
type Doc = {
  id: string; entity_id: string; doc_type: string; doc_number: number;
  issue_date: string; client_snapshot: { name?: string; tax_id?: string }; total_agorot: number; created_at: string;
  // קיימים רק ב-API המעודכן של מערכת החשבוניות — בלעדיהם נופלים ל-GET /documents/{id}
  ref_document_id?: string | null; ref_historical_id?: string | null;
  ref_document?: RefDoc | null; ref_historical?: RefDoc | null; payment_state?: PaymentState;
};
type Detail = { document?: Doc; payment_state?: PaymentState; ref_document?: RefDoc | null; ref_historical?: RefDoc | null };
type Link = { known: boolean; refDocId: string | null; refDoc: RefDoc | null; refHistId: string | null; refHist: RefDoc | null };
type Row = Record<string, unknown>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  // ── אימות: סוד משותף בכותרת (לא ב-URL — כתובות נכתבות ללוגים) ──
  const SYNC_KEY = Deno.env.get("INVOICES_SYNC_KEY") || "";
  if (!SYNC_KEY || (req.headers.get("x-sync-key") || "") !== SYNC_KEY) return json({ error: "unauthorized" }, 401);
  try {
    // ── סודות. המפתח לעולם לא נכתב ללוג ולא חוזר בתשובה ──
    const API_KEY = Deno.env.get("INVOICES_API_KEY") || "";
    const API_BASE = (Deno.env.get("INVOICES_API_BASE") || "https://invoices.arazim-eng.co.il").replace(/\/+$/, "");
    if (!API_KEY) return json({ error: "missing INVOICES_API_KEY" }, 500);

    // מיפוי ישות: uuid של entity במערכת החשבוניות → 'עוסק'/'חברה' בטבלה.
    // ‏GET /entities עדיין לא ממומש ב-API, ושיוך כספי לא מנחשים — לכן המיפוי
    // מוגדר כסוד ומסמך של ישות לא מוכרת מדולג ומדווח, לא נתלה בברירת מחדל.
    let entityMap: Record<string, string> = {};
    try { entityMap = JSON.parse(Deno.env.get("INVOICES_ENTITY_MAP") || "{}"); } catch { /* נבדק מיד */ }
    if (!Object.keys(entityMap).length) return json({ error: "missing/invalid INVOICES_ENTITY_MAP" }, 500);
    // ⚠️ הסוד נכתב בקודים לטיניים (osek/company): האות ס' בערך עברי הגיעה
    // משובשת מ-Deno.env (נתפס בהרצה היבשה 11.10.26) ושברה את המיזוג לפי ישות.
    const ENTITY_CODES: Record<string, string> = { osek: "עוסק", company: "חברה" };
    for (const k of Object.keys(entityMap)) {
      const v = ENTITY_CODES[entityMap[k]] ?? entityMap[k];
      if (v !== "עוסק" && v !== "חברה") return json({ error: "invalid INVOICES_ENTITY_MAP value" }, 500);
      entityMap[k] = v;
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const url = new URL(req.url);
    const dry = url.searchParams.get("dry") === "1";
    const from = url.searchParams.get("from");      // YYYY-MM-DD (issue_date)
    const all = url.searchParams.get("all") === "1";
    const backfill = Boolean(from) || all;

    // ── סימן המים ──
    const { data: state } = await admin.from("sync_state").select("*").eq("source", SOURCE).maybeSingle();
    const since = backfill ? null : sinceWithOverlap(state?.last_created_at ?? null, OVERLAP_MINUTES);

    // ── שליפה מדף לדף (keyset, created_at desc) ──
    // ⚠️ תאריכים משווים כמספרים ולא כמחרוזות: ה-API מחזיר "+00:00" ואילו
    // toISOString מחזיר "Z", ושתי המחרוזות לא ניתנות להשוואה לקסיקוגרפית.
    const ms = (t: string | null | undefined) => (t ? Date.parse(t) : NaN);
    const sinceMs = ms(since);

    const docs: Doc[] = [];
    let cursor: string | null = null, pages = 0, reachedWatermark = false;
    while (pages < MAX_PAGES) {
      const q = new URL(`${API_BASE}/api/v1/documents`);
      q.searchParams.set("limit", String(PAGE));
      if (from) q.searchParams.set("from", from);
      if (cursor) q.searchParams.set("cursor", cursor);
      const res = await fetch(q.toString(), { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // גוף השגיאה עלול להכיל פרטים — מחזירים קוד וטקסט קצוץ בלבד
        return json({ error: "api_error", status: res.status, detail: body.slice(0, 200) }, 502);
      }
      const payload = await res.json() as { documents: Doc[]; next_cursor: string | null };
      pages++;
      for (const d of payload.documents ?? []) {
        if (!Number.isNaN(sinceMs) && ms(d.created_at) <= sinceMs) { reachedWatermark = true; break; }
        docs.push(d);
      }
      cursor = payload.next_cursor;
      if (reachedWatermark || !cursor) break;
    }

    // ── מיפוי ──
    const scanned = docs.length;
    const rows: { row: Row; docType: string; doc: Doc }[] = [];
    const skipped: Record<string, number> = {};
    for (const d of docs) {
      const m = mapDocument(d, entityMap, API_BASE) as Mapped;
      if (m.skip || !m.row) { const k = m.skip ?? "no_row"; skipped[k] = (skipped[k] ?? 0) + 1; continue; }
      rows.push({ row: m.row, docType: m.docType ?? "", doc: d });
    }

    const api = async (path: string) => {
      const res = await fetch(`${API_BASE}/api/v1${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
      if (!res.ok) throw new Error(`api ${res.status} ${path.split("?")[0]}`);
      return await res.json();
    };
    // דיווחים שדורשים עין אנושית (בלי שמות לקוחות): קישור שלא נפתר, קבלה חלקית…
    const reports: { doc: string; reason: string }[] = [];
    const docLabel = (d: Doc) => `${entityMap[d.entity_id] ?? "?"} ${d.doc_type} ${d.doc_number}`;

    // ── קישורים (קבלה→חשבונית, חשבונית→חשבון עסקה) ──
    // ה-API המעודכן מחזיר אותם ברשימה; הישן לא, ואז קוראים למסמך עצמו.
    const links = new Map<string, Link>();
    const linkDocs = rows.filter((r) => LINK_TYPES.includes(r.docType));
    let detailCalls = 0;
    await pool(linkDocs, 5, async ({ doc }) => {
      let detail: Detail | null = null;
      if (!Object.prototype.hasOwnProperty.call(doc, "ref_document_id")) {
        if (detailCalls >= DETAIL_CAP) { reports.push({ doc: docLabel(doc), reason: "link_not_checked_cap" }); return; }
        detailCalls++;
        try { detail = await api(`/documents/${doc.id}`) as Detail; }
        catch (e) { reports.push({ doc: docLabel(doc), reason: "link_fetch_failed: " + String(e).slice(0, 60) }); return; }
      }
      const link = linkOf(doc, detail) as Link;
      if (link.known && (link.refDocId || link.refHistId)) links.set(doc.id, link);
    });

    // ── מה כבר קיים בטבלה: לפי id (ריצה חוזרת) ולפי מספר מסמך (מיזוג / מסמך עבר) ──
    const ids = [...new Set([
      ...rows.map((r) => String(r.row.id)),
      ...[...links.values()].filter((l) => l.refDocId).map((l) => "arz-" + l.refDocId),
    ])];
    const numbers = [...new Set([
      ...rows.map((r) => String(r.row.invoice_number)),
      ...[...links.values()].filter((l) => l.refHist?.doc_number != null).map((l) => String(l.refHist!.doc_number)),
    ])].filter(Boolean);
    const byId = new Map<string, Record<string, unknown>>();
    const byNumber = new Map<string, Record<string, unknown>[]>();
    const SEL = "id,invoice_number,invoice_type,amount,entity,date_sent,file_url,project_id," +
      "submitted_to_muni,muni_submit_date,status,date_paid,closes_id,exclude_cashflow";
    for (const chunk of chunks(ids, 200)) {
      const { data } = await admin.from("invoices").select(SEL).in("id", chunk);
      for (const r of data ?? []) byId.set(String(r.id), r);
    }
    for (const chunk of chunks(numbers, 200)) {
      const { data } = await admin.from("invoices").select(SEL).in("invoice_number", chunk);
      for (const r of data ?? []) {
        const k = String(r.invoice_number);
        byNumber.set(k, [...(byNumber.get(k) ?? []), r]);
      }
    }

    // ── הכרעה לכל שורה: חדשה / עדכון / ללא שינוי / התנגשות ──
    const now = new Date().toISOString();
    const toInsert: Row[] = [];
    const toUpdate: { id: string; patch: Row }[] = [];
    const toMerge: { row: Row; manualId: string }[] = [];
    // שורות שייכתבו בריצה הזו (חדשות/ממוזגות) — כדי שקישור יוכל לעדכן אותן
    // עוד לפני הכתיבה; ושורות ידניות שנמחקות במיזוג — שלא ייבחרו כיעד.
    const pending = new Map<string, Row>();
    const mergedAway = new Set<string>();
    const conflicts: string[] = [];
    const sample: Record<string, unknown>[] = [];
    let unchanged = 0;

    for (const { row } of rows) {
      const id = String(row.id);
      const existing = byId.get(id);
      if (existing) {
        const changed = changedFields(existing, row);
        if (!changed.length) { unchanged++; continue; }
        // שורה קיימת: כותבים **רק** את השדות שבבעלות הסנכרון (OWNED_FIELDS),
        // כדי לא לדרוס "שולם", שיוך לפרויקט או הערות שנרשמו ידנית.
        const patch: Record<string, unknown> = { updated_at: now };
        for (const f of changed) patch[f] = row[f];
        toUpdate.push({ id, patch });
        sample.push({ action: "update", id, fields: changed, ...brief(row) });
        continue;
      }
      const candidates = byNumber.get(String(row.invoice_number)) ?? [];
      const clash = pickAutomatedClash(candidates, row);
      if (clash) {
        // אותו מסמך כבר יושב בטבלה משורת איזי קאונט/סאמיט. לא ממזגים ולא
        // מוחקים (השורות האלה "לא נוגעים בהן לעולם") ולא מוסיפים שורה שנייה
        // שתיספר פעמיים — מדווחים ומשה מכריע.
        conflicts.push(`${id} ↔ ${clash.id}`);
        sample.push({ action: "conflict", id, with: clash.id, ...brief(row) });
        continue;
      }
      const manual = pickManualDuplicate(candidates, row);
      if (manual) {
        const merged = { ...inheritFromManual(row, manual), created_at: now, updated_at: now } as Row;
        toMerge.push({ row: merged, manualId: String(manual.id) });
        pending.set(id, merged); mergedAway.add(String(manual.id));
        sample.push({ action: "merge", id, replaces: String(manual.id), ...brief(row) });
        continue;
      }
      // date_paid/closes_id תמיד מפורשים: שורות באותה אצווה חייבות אותם מפתחות
      const fresh = { date_paid: null, closes_id: null, ...row, created_at: now, updated_at: now } as Row;
      toInsert.push(fresh); pending.set(id, fresh);
      sample.push({ action: "insert", id, ...brief(row) });
    }

    // ── השפעת הקישורים: "שולם" על החוב שקבלה סגרה, closes_id על חשבונית מס ──
    // עדכון של שורה שקיימת כבר במסד נאסף ל-linkUpdates; שורה שנכתבת בריצה
    // הזו מתעדכנת בזיכרון. אידמפוטנטי: "שולם" לא נכתב על שורה ששולמה/בוטלה,
    // ו-closes_id לא נכתב על שורה שכבר יש לה (ידני גובר).
    const linkUpdates = new Map<string, Row>();
    const patchRow = (id: string, patch: Row) => {
      const p = pending.get(id);
      if (p) Object.assign(p, patch);
      else linkUpdates.set(id, { ...(linkUpdates.get(id) ?? {}), ...patch, updated_at: now });
    };
    let linkedPaid = 0, linkedCloses = 0;
    for (const { doc, row } of rows) {
      const link = links.get(doc.id);
      if (!link) continue;
      const selfId = String(row.id);
      const self = pending.get(selfId) ?? byId.get(selfId);
      if (!self) continue;                       // התנגשות — השורה לא נכתבת, אין מה לקשר
      let target: Row | null = null, gross = 0;
      if (link.refDocId) {
        const tid = "arz-" + link.refDocId;
        target = pending.get(tid) ?? byId.get(tid) ?? null;
        // שורות arz- מחזיקות סכום כולל מע"מ — זה הסכום של מסמך המקור
        gross = link.refDoc ? agorotToShekels(link.refDoc.total_agorot) : Math.abs(Number(target?.amount) || 0);
        if (!target) { reports.push({ doc: docLabel(doc), reason: "ref_not_in_table" }); continue; }
      } else if (link.refHist) {
        const cands = (byNumber.get(String(link.refHist.doc_number)) ?? []).filter((r) => !mergedAway.has(String(r.id)));
        const hit = pickHistoricalTarget(cands, link.refHist, row.entity) as { row: Row | null; reason: string | null; typeMismatch: boolean };
        if (!hit.row) { reports.push({ doc: docLabel(doc), reason: `${hit.reason}: ${link.refHist.doc_type} ${link.refHist.doc_number}` }); continue; }
        // זוהה בוודאות (מספר+ישות+סכום) אבל הסוג בטבלה שונה מהמסמך — מדווח כדי שיתוקן ידנית
        if (hit.typeMismatch) reports.push({ doc: docLabel(doc), reason: `type_mismatch_in_table: ${link.refHist.doc_number} רשום כ"${hit.row.invoice_type}" אבל הוא ${link.refHist.doc_type}` });
        target = hit.row; gross = agorotToShekels(link.refHist.total_agorot);
      } else {
        // יש ref_historical_id אבל ה-API (הישן) לא מחזיר את פרטי מסמך העבר
        reports.push({ doc: docLabel(doc), reason: "historical_ref_needs_api_update" }); continue;
      }
      const plan = planLink(doc, target, gross) as { targetPatch: Row | null; closesId: string | null; report: string | null };
      if (plan.report) reports.push({ doc: docLabel(doc), reason: `${plan.report}: ${target.invoice_type} ${target.invoice_number}` });
      if (plan.targetPatch) {
        patchRow(String(target.id), plan.targetPatch); linkedPaid++;
        sample.push({ action: "mark_paid", id: String(target.id), by: selfId, number: target.invoice_number, type: target.invoice_type });
      }
      if (plan.closesId && !self.closes_id) {
        patchRow(selfId, { closes_id: plan.closesId }); linkedCloses++;
        sample.push({ action: "closes", id: selfId, closes: plan.closesId, number: row.invoice_number, type: row.invoice_type });
      }
    }

    // ── בדיקה חוזרת: שורות arz- שעדיין 'sent' — אולי שולמו בינתיים ──
    // (תשלום חלקי שהושלם, קבלה שהסנכרון לא הצליח לקשר, זיכוי מלא.)
    // סימן המים הוא לפי created_at של מסמכים חדשים, ולכן שינוי מצב של מסמך
    // ישן לא מגיע דרכו — זו הדרך היחידה לתפוס אותו.
    const recheck = { checked: 0, marked: 0, mode: "none", truncated: false };
    {
      const { data: open, error: openErr } = await admin.from("invoices")
        .select("id,invoice_number,invoice_type,date_sent,status")
        .like("id", "arz-%").eq("status", "sent").in("invoice_type", DEBT_LABELS)
        .order("date_sent", { ascending: true }).limit(RECHECK_LIMIT);
      if (openErr) reports.push({ doc: "recheck", reason: "db: " + openErr.message.slice(0, 80) });
      const todo = ((open ?? []) as Row[]).filter((r) => needsRecheck(r) && !("status" in (linkUpdates.get(String(r.id)) ?? {})));
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
      const settle = (r: Row, total: unknown, ps: PaymentState | undefined) => {
        recheck.checked++;
        if (!isSettled(total, ps)) return;
        patchRow(String(r.id), { status: "paid", date_paid: paidDate(ps, today) }); recheck.marked++;
        sample.push({ action: "mark_paid", id: String(r.id), by: "recheck", number: r.invoice_number, type: r.invoice_type });
      };
      try {
        let bulk = true;
        for (const chunk of chunks(todo, IDS_CHUNK)) {
          if (!bulk) break;
          const want = new Map(chunk.map((r) => [String(r.id).slice(4), r]));
          const out = await api(`/documents?limit=200&ids=${[...want.keys()].join(",")}`) as { documents: Doc[] };
          const got = out.documents ?? [];
          // ‏API ישן מתעלם מ-ids ומחזיר מסמכים בלי payment_state ⇒ מסלול הגיבוי
          if (got.some((d) => !Object.prototype.hasOwnProperty.call(d, "payment_state"))) { bulk = false; break; }
          recheck.mode = "bulk";
          for (const d of got) { const r = want.get(d.id); if (r) settle(r, d.total_agorot, d.payment_state); }
        }
        if (!bulk) {
          recheck.mode = "detail"; recheck.truncated = todo.length > RECHECK_DETAIL_CAP;
          await pool(todo.slice(0, RECHECK_DETAIL_CAP), 5, async (r) => {
            const det = await api(`/documents/${String(r.id).slice(4)}`) as Detail;
            settle(r, det.document?.total_agorot, det.payment_state);
          });
        }
      } catch (e) {
        // כישלון כאן לא מפיל את הריצה — הבדיקה תחזור בריצה הבאה
        reports.push({ doc: "recheck", reason: String(e).slice(0, 80) });
      }
    }

    const plan = {
      scanned, skipped: sum(skipped), skipped_by_reason: skipped, unchanged,
      insert: toInsert.length, update: toUpdate.length, merge: toMerge.length,
      conflicts: conflicts.length, pages, reached_watermark: reachedWatermark,
      linked_paid: linkedPaid, linked_closes: linkedCloses, recheck, reports: reports.length,
      link_updates: linkUpdates.size, detail_calls: detailCalls,
    };

    if (dry) {
      console.log(`[invoices-sync] DRY ${JSON.stringify(plan)}`);
      return json({
        ok: true, dry: true, ...plan, conflicts, report_list: reports.slice(0, 100),
        since: since ?? null, from: from ?? null,
        // דוגמה בלי שמות לקוחות — רק מה שצריך כדי לאמת בעיניים
        sample: sample.slice(0, 50),
        scanned_note: pages >= MAX_PAGES ? "הגענו לתקרת העמודים — יש עוד מסמכים" : null,
      });
    }

    // ── כתיבה ──
    const errors: { id: string; error: string }[] = [];
    let upserted = 0;
    for (const chunk of chunks(toInsert, UPSERT_CHUNK)) {
      const { error } = await admin.from("invoices").upsert(chunk, { onConflict: "id" });
      if (error) errors.push({ id: `insert x${chunk.length}`, error: error.message });
      else upserted += chunk.length;
    }
    for (const u of toUpdate) {
      const { error } = await admin.from("invoices").update(u.patch).eq("id", u.id);
      if (error) errors.push({ id: u.id, error: error.message });
      else upserted++;
    }
    for (const m of toMerge) {
      // סדר חשוב: קודם השורה החדשה (עם מה שירשה), ורק אם הצליחה מוחקים את
      // הידנית. אחרת כישלון באמצע היה משאיר את הטבלה בלי אף אחת מהשתיים.
      const { error } = await admin.from("invoices").upsert(m.row, { onConflict: "id" });
      if (error) { errors.push({ id: String(m.row.id), error: error.message }); continue; }
      const { error: delErr } = await admin.from("invoices").delete().eq("id", m.manualId);
      if (delErr) errors.push({ id: m.manualId, error: "delete: " + delErr.message });
      upserted++;
    }
    // קישורים ובדיקה חוזרת — אחרי שהשורות החדשות כבר במסד. "שולם" נכתב רק על
    // שורה שעדיין לא שולמה/בוטלה, כדי שריצה חוזרת או מרוץ מול עריכה ידנית
    // לא ידרסו תאריך תשלום שמשה הזין.
    let linkWritten = 0;
    for (const [id, patch] of linkUpdates) {
      let q = admin.from("invoices").update(patch).eq("id", id);
      if ("status" in patch) q = q.not("status", "in", "(paid,cancelled)");
      const { error } = await q;
      if (error) errors.push({ id, error: "link: " + error.message });
      else linkWritten++;
    }

    // ── סימן המים ──
    // מקדמים רק כשאין שגיאות: מסמך שנכשל חייב להיסרק שוב בריצה הבאה,
    // והכתיבה אידמפוטנטית ולכן סריקה חוזרת לא עולה כלום.
    // ⚠️ הערך ההתחלתי ריק ו-ms("") הוא NaN — בלי הבדיקה `!a` ההשוואה תמיד
    // נכשלת, maxSeen נשאר ריק וסימן המים לא נכתב אף פעם (נתפס בבדיקה 11.10.26).
    const maxSeen = docs.reduce((a, d) => (!a || ms(d.created_at) > ms(a) ? d.created_at : a), "");
    const keep: string = state?.last_created_at ?? "";
    // מונוטוני: סימן המים אף פעם לא יורד, גם אחרי מילוי למפרע של טווח ישן
    const nextWatermark = (ms(maxSeen) > ms(keep) || !keep) ? maxSeen : keep;
    if (!errors.length && nextWatermark) {
      const { error } = await admin.from("sync_state").upsert({
        source: SOURCE, last_run: now, last_created_at: nextWatermark,
        note: `insert=${toInsert.length} update=${toUpdate.length} merge=${toMerge.length} conflicts=${conflicts.length} paid=${linkedPaid + recheck.marked} reports=${reports.length}`,
      }, { onConflict: "source" });
      if (error) errors.push({ id: "sync_state", error: error.message });
    } else if (errors.length) {
      await admin.from("sync_state").upsert({
        source: SOURCE, last_run: now, last_created_at: state?.last_created_at ?? null,
        note: `errors=${errors.length} — סימן המים לא קודם`,
      }, { onConflict: "source" });
    }

    // לוג: מספרים בלבד, בלי שמות לקוחות ובלי מפתחות
    console.log(`[invoices-sync] ${JSON.stringify({ ...plan, upserted, link_written: linkWritten, errors: errors.length })}`);
    return json({ ok: errors.length === 0, ...plan, upserted, link_written: linkWritten, errors, conflicts, report_list: reports.slice(0, 100) });
  } catch (e) {
    console.error("[invoices-sync] fatal", String(e));
    return json({ error: String(e) }, 500);
  }
});

/** תקציר שורה לדוח יבש — בלי שם הלקוח (notes) */
function brief(row: Record<string, unknown>) {
  return {
    number: row.invoice_number, type: row.invoice_type,
    entity: row.entity, amount: row.amount, date_sent: row.date_sent,
  };
}
/** מריץ fn על כל הפריטים, עד n במקביל (קריאות ל-API בלי להציף אותו). */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
function sum(m: Record<string, number>) { return Object.values(m).reduce((a, b) => a + b, 0); }
function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
