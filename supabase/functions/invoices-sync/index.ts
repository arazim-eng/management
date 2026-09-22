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
} from "./mapping.js";

const SOURCE = "arazim-invoices";     // מפתח השורה ב-sync_state
const PAGE = 200;                     // תקרת ה-API
const MAX_PAGES = 25;                 // 5,000 מסמכים לריצה — גדר מפני timeout
const OVERLAP_MINUTES = 10;           // חפיפה לאחור, ראו sinceWithOverlap
const UPSERT_CHUNK = 100;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

/** צורת ההחזרה של mapDocument (הקובץ עצמו JS כדי שאפשר יהיה לבדוק אותו ב-node) */
type Mapped = { skip: string | null; row: Record<string, unknown> | null; docType: string | null };

type Doc = {
  id: string; entity_id: string; doc_type: string; doc_number: number;
  issue_date: string; client_snapshot: { name?: string }; total_agorot: number; created_at: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
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
    const rows: { row: Record<string, unknown>; docType: string }[] = [];
    const skipped: Record<string, number> = {};
    for (const d of docs) {
      const m = mapDocument(d, entityMap, API_BASE) as Mapped;
      if (m.skip || !m.row) { const k = m.skip ?? "no_row"; skipped[k] = (skipped[k] ?? 0) + 1; continue; }
      rows.push({ row: m.row, docType: m.docType ?? "" });
    }

    // ── מה כבר קיים בטבלה: לפי id (ריצה חוזרת) ולפי מספר מסמך (מיזוג) ──
    const ids = rows.map((r) => String(r.row.id));
    const numbers = [...new Set(rows.map((r) => String(r.row.invoice_number)))].filter(Boolean);
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
    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];
    const toMerge: { row: Record<string, unknown>; manualId: string }[] = [];
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
        toMerge.push({ row: inheritFromManual(row, manual), manualId: String(manual.id) });
        sample.push({ action: "merge", id, replaces: String(manual.id), ...brief(row) });
        continue;
      }
      toInsert.push({ ...row, created_at: now, updated_at: now });
      sample.push({ action: "insert", id, ...brief(row) });
    }

    const plan = {
      scanned, skipped: sum(skipped), skipped_by_reason: skipped, unchanged,
      insert: toInsert.length, update: toUpdate.length, merge: toMerge.length,
      conflicts: conflicts.length, pages, reached_watermark: reachedWatermark,
    };

    if (dry) {
      console.log(`[invoices-sync] DRY ${JSON.stringify(plan)}`);
      return json({
        ok: true, dry: true, ...plan, conflicts,
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
      const { error } = await admin.from("invoices").upsert({ ...m.row, created_at: now, updated_at: now }, { onConflict: "id" });
      if (error) { errors.push({ id: String(m.row.id), error: error.message }); continue; }
      const { error: delErr } = await admin.from("invoices").delete().eq("id", m.manualId);
      if (delErr) errors.push({ id: m.manualId, error: "delete: " + delErr.message });
      upserted++;
    }

    // ── סימן המים ──
    // מקדמים רק כשאין שגיאות: מסמך שנכשל חייב להיסרק שוב בריצה הבאה,
    // והכתיבה אידמפוטנטית ולכן סריקה חוזרת לא עולה כלום.
    const maxSeen = docs.reduce((a, d) => (ms(d.created_at) > ms(a) ? d.created_at : a), "");
    const keep: string = state?.last_created_at ?? "";
    // מונוטוני: סימן המים אף פעם לא יורד, גם אחרי מילוי למפרע של טווח ישן
    const nextWatermark = (ms(maxSeen) > ms(keep) || !keep) ? maxSeen : keep;
    if (!errors.length && nextWatermark) {
      const { error } = await admin.from("sync_state").upsert({
        source: SOURCE, last_run: now, last_created_at: nextWatermark,
        note: `insert=${toInsert.length} update=${toUpdate.length} merge=${toMerge.length} conflicts=${conflicts.length}`,
      }, { onConflict: "source" });
      if (error) errors.push({ id: "sync_state", error: error.message });
    } else if (errors.length) {
      await admin.from("sync_state").upsert({
        source: SOURCE, last_run: now, last_created_at: state?.last_created_at ?? null,
        note: `errors=${errors.length} — סימן המים לא קודם`,
      }, { onConflict: "source" });
    }

    // לוג: מספרים בלבד, בלי שמות לקוחות ובלי מפתחות
    console.log(`[invoices-sync] ${JSON.stringify({ ...plan, upserted, errors: errors.length })}`);
    return json({ ok: errors.length === 0, ...plan, upserted, errors, conflicts });
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
function sum(m: Record<string, number>) { return Object.values(m).reduce((a, b) => a + b, 0); }
function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
