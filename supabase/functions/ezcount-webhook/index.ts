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
  // אימות (16.8, ממצא Codex): בלי זה כל מי שמכיר את הכתובת יכול לזייף חשבונית,
  // לדרוס מסמך קיים ואף למחוק שורה ידנית דרך מנגנון המיזוג. המפתח מוגדר כ-secret
  // של הפונקציה, ומתקבל משני מסלולים. איזי קאונט מוגדרים כיום עם ?key= בכתובת,
  // אך הם כן תומכים בכותרות מותאמות ("+ מתקדם (request header)" במסך ההגדרות) —
  // מעבר ל-x-webhook-key עדיף, כי הכתובת נכתבת ללוגים והמפתח איתה.
  // ⚠️ שינוי המפתח כאן מחייב עדכון מקביל במסך ההגדרות של איזי קאונט, אחרת כל
  // מסמך נדחה ב-401 בשקט; אחרי 5 דחיות איזי קאונט מנתקים את ה-webhook לגמרי.
  const KEY = Deno.env.get("EZCOUNT_WEBHOOK_KEY") || "";
  const given = new URL(req.url).searchParams.get("key") || req.headers.get("x-webhook-key") || "";
  if (!KEY || given !== KEY) return json({ error: "unauthorized" }, 401);
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
    // 10.8.26 — מניעת כפילויות: אותו מסמך נרשם לעיתים גם ידנית (סכום ללא מע"מ) לפני
    // שה-webhook מגיע. אם קיימת שורה ידנית עם אותו מספר מסמך והסכום תואם (זהה או ×1.18),
    // ממזגים: השורה כאן שומרת את ה-PDF, ויורשת מהידנית את השיוך לפרויקט, ההגשה לעירייה
    // וסטטוס התשלום — והשורה הידנית נמחקת. שורות ezcount-/sumit- אחרות לעולם לא נוגעים בהן.
    let merged: string | null = null;
    const { data: sameNum } = await admin.from("invoices")
      .select("id,amount,project_id,submitted_to_muni,muni_submit_date,status,date_paid,closes_id,exclude_cashflow")
      .eq("invoice_number", row.invoice_number);
    const manual = (sameNum ?? []).find((r) => {
      if (r.id === row.id || r.id.startsWith("ezcount-") || r.id.startsWith("sumit-")) return false;
      const a = Math.abs(Number(r.amount) || 0), b = Math.abs(row.amount) || 0;
      if (!a || !b) return false;
      return Math.abs(a - b) <= 2 || Math.abs(a * 1.18 - b) <= 2; // זהה, או ידני ללא מע"מ מול כולל מע"מ
    });
    if (manual) {
      Object.assign(row, {
        project_id: manual.project_id ?? null,
        submitted_to_muni: manual.submitted_to_muni ?? false,
        muni_submit_date: manual.muni_submit_date ?? null,
        closes_id: manual.closes_id ?? null,
        exclude_cashflow: manual.exclude_cashflow ?? false,
        ...(manual.status === "paid" ? { status: "paid", date_paid: manual.date_paid ?? dateIso } : {}),
      });
      merged = manual.id;
    }
    const { error } = await admin.from("invoices").upsert(row, { onConflict: "id" });
    if (error) return json({ ok: false, error: error.message });
    if (merged) await admin.from("invoices").delete().eq("id", merged);
    return json({ ok: true, synced: row.invoice_number, amount: row.amount, merged });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
