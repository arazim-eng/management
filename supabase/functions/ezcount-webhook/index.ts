// מקלט webhook מאיזי קאונט (עוסק) — כל מסמך חדש → טבלת הניהול. מיפוי לפי שמות השדות האמיתיים.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
function json(b: unknown, s = 200): Response { return new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } }); }

// קודי סוג מסמך איזי קאונט
const TYPE_MAP: Record<number, string> = {
  320: "חשבונית מס", 305: "חשבונית מס קבלה", 330: "חשבונית זיכוי",
  400: "קבלה", 405: "קבלה על תרומה", 300: "חשבון עסקה", 100: "הצעת מחיר", 200: "הזמנה",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const p = await req.json().catch(() => ({}));

    // מדלגים על הודעות בדיקה — שלא יזהמו את הטבלה
    if (p?.EZCOUNT_TEST_REQUEST === true) {
      return json({ ok: true, test: true, note: "הודעת בדיקה — לא נשמרה" });
    }

    const uuid = p.doc_uuid || p.doc_transaction_id;
    const number = p.doc_number;
    if (!uuid && !number) return json({ ok: false, error: "no_doc_id" });

    const type = Number(p.doc_type);
    // 21.7.26 משה: הצעות מחיר והזמנות לא מעניינות — לא נכנסות לטבלה
    if (type === 100 || type === 200) {
      return json({ ok: true, skipped: true, note: "הצעת מחיר/הזמנה — לא נשמרת" });
    }
    const total = Number(p.doc_price_total ?? p.calculatedData?.price_total ?? p.doc_price ?? 0);
    const isCredit = type === 330;
    // תאריך: מעדיפים calculatedData.date (ISO), אחרת doc_date DD/MM/YYYY
    let dateIso: string | null = p.calculatedData?.date || null;
    if (!dateIso && p.doc_date) { const m = String(p.doc_date).match(/(\d{2})\/(\d{2})\/(\d{4})/); if (m) dateIso = `${m[3]}-${m[2]}-${m[1]}`; }

    const row = {
      id: "ezcount-" + (uuid || number),
      invoice_number: String(number ?? uuid),
      invoice_type: TYPE_MAP[type] || (isCredit ? "חשבונית זיכוי" : "חשבונית מס"),
      amount: isCredit ? -Math.abs(total) : total,
      entity: "עוסק",
      date_sent: dateIso,
      status: "sent",
      notes: p.doc_customer_name || null,
      file_url: p.pdf_link || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("invoices").upsert(row, { onConflict: "id" });
    if (error) return json({ ok: false, error: error.message });
    return json({ ok: true, synced: row.invoice_number, amount: row.amount });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
