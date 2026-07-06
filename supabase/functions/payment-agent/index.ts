import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AZURE_TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const AZURE_CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const AZURE_CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") || "moshe@arazim-eng.co.il";

const MAILBOXES = ["moshe@arazim-eng.co.il", "office@arazim-eng.co.il"];
const PAYMENT_SENDERS = ["jersupplier@jerusalem.muni.il", "no-replay@ladpc.co.il"];
const EZCOUNT_SENDER = "noreply@ezcount.co.il";
// How far back to scan. Combined with the processed_emails table this makes the
// agent independent of read/unread state (the old isRead filter meant any mail a
// human opened first was silently skipped forever).
const LOOKBACK_DAYS = 7;

const sbHeaders = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

async function getAzureToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Azure token failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.access_token;
}

// Fetch recent messages from a folder and filter by sender client-side.
// A combined $filter on from + isRead with $orderby is rejected by Graph as an
// inefficient filter — that silent failure is why the agent never processed anything.
// Scan the WHOLE mailbox (all folders), not just Inbox — municipality mails get
// moved to subfolders by rules/the secretary and must still be picked up.
async function getEmails(token: string, mailbox: string, results: string[]) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let url: string | null = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?` +
    `$filter=receivedDateTime ge ${since}` +
    `&$select=id,internetMessageId,subject,from,receivedDateTime,body,hasAttachments` +
    `&$orderby=receivedDateTime desc&$top=100`;
  const all: any[] = [];
  // paginate — a busy mailbox has far more than one page per week
  for (let page = 0; url && page < 15; page++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      results.push(`❌ Graph ${mailbox}: ${res.status} ${body.slice(0, 200)}`);
      break;
    }
    const data = await res.json();
    all.push(...(data.value || []));
    url = data["@odata.nextLink"] || null;
  }
  return all;
}

function fromAddress(email: any): string {
  return (email.from?.emailAddress?.address || "").toLowerCase();
}

// message key that is stable across mailboxes (same mail delivered to both
// moshe@ and office@ carries the same internetMessageId → processed once)
function messageKey(email: any): string {
  return email.internetMessageId || email.id;
}

async function getProcessedIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - (LOOKBACK_DAYS + 2) * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/processed_emails?select=message_id&processed_at=gte.${since}`,
    { headers: sbHeaders }
  );
  if (!res.ok) return new Set();
  const rows = await res.json();
  return new Set(rows.map((r: any) => r.message_id));
}

async function markProcessed(email: any, mailbox: string, outcome: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/processed_emails`, {
    method: "POST",
    headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      message_id: messageKey(email),
      mailbox,
      sender: fromAddress(email),
      subject: (email.subject || "").slice(0, 300),
      outcome,
    }),
  }).catch(() => {});
}

async function getAttachments(token: string, mailbox: string, messageId: string) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.value || []).filter((a: any) =>
    a.contentType === "application/pdf" || a.name?.toLowerCase().endsWith(".pdf")
  );
}

function extractInvoiceFromSubject(subject: string): { number: string; type: string } | null {
  const types: Record<string, string> = {
    "הצעת מחיר": "הצעת מחיר",
    "חשבונית עסקה": "חשבון עסקה",
    "חשבון עסקה": "חשבון עסקה",
    "חשבונית מס קבלה": "חשבונית מס",
    "חשבונית מס": "חשבונית מס",
    "קבלה": "קבלה",
  };
  for (const [pattern, type] of Object.entries(types)) {
    const regex = new RegExp(pattern + "\\s+(\\d+)");
    const match = subject.match(regex);
    if (match) return { number: match[1], type };
  }
  return null;
}

// The EZcount link is wrapped in an AWS-tracking redirect with percent-encoding,
// and the plain /copy?email=... endpoint returns an HTML redirect page.
// Decode the body, pull the document UUID, and hit /copy?nc=1 which serves the PDF.
function extractPDFLink(body: string): string | null {
  const decoded = body.replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%3F/gi, "?").replace(/%3D/gi, "=").replace(/%26/gi, "&");
  const match = decoded.match(/files\.ezcount\.co\.il\/front\/documents\/get\/([a-f0-9-]{20,})/i);
  return match ? `https://files.ezcount.co.il/front/documents/get/${match[1]}/copy?nc=1` : null;
}

async function downloadPDF(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // must actually be a PDF (%PDF) — the endpoint sometimes serves HTML
    if (bytes.length < 4 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46) return null;
    return bytes;
  } catch { return null; }
}

function isPdf(bytes: Uint8Array | null): boolean {
  return !!bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

async function uploadToStorage(invoiceId: string, pdfBytes: Uint8Array): Promise<string | null> {
  const path = `${invoiceId}.pdf`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/invoices/${path}`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true"
    },
    body: pdfBytes
  });
  if (!res.ok) return null;
  // store the object path; the app signs URLs on demand (bucket is private)
  return path;
}

async function getInvoices() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?select=*`, { headers: sbHeaders });
  return await res.json();
}

async function updateInvoicePDF(invoiceId: string, filePath: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoiceId}`, {
    method: "PATCH",
    headers: { ...sbHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({ file_url: filePath, updated_at: new Date().toISOString() })
  });
}

async function updateInvoiceStatus(invoiceId: string, paymentDate: string | null) {
  await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoiceId}`, {
    method: "PATCH",
    headers: { ...sbHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify({
      status: "paid",
      date_paid: paymentDate || new Date().toISOString().slice(0, 10),
      updated_at: new Date().toISOString()
    })
  });
}

const PAYMENT_SCHEMA = {
  type: "object",
  properties: {
    invoices: {
      type: "array",
      description: "פירוט החשבוניות ששולמו לפי המסמך",
      items: {
        type: "object",
        properties: {
          number: { type: "string", description: "מספר החשבונית" },
          amount: { type: ["number", "null"], description: "הסכום ששולם עבור חשבונית זו" },
        },
        required: ["number", "amount"],
        additionalProperties: false,
      },
    },
    total_amount: { type: ["number", "null"], description: "הסכום הכולל ששולם" },
    payment_date: { type: ["string", "null"], description: "תאריך התשלום YYYY-MM-DD" },
    payer: { type: ["string", "null"], description: "שם המשלם (עירייה/גוף)" },
    payee_entity: {
      type: ["string", "null"],
      enum: ["עוסק", "חברה", null],
      description: "המוטב שקיבל את התשלום: 'עוסק' אם המוטב הוא משה סעדה עוסק מורשה, 'חברה' אם המוטב הוא מ.ס ארזים הנדסה בע\"מ",
    },
  },
  required: ["invoices", "total_amount", "payment_date", "payer", "payee_entity"],
  additionalProperties: false,
};

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    amount: { type: ["number", "null"], description: "סכום החשבונית לפני מע\"מ" },
    client_name: { type: ["string", "null"], description: "שם הלקוח שאליו הופנתה החשבונית" },
    date: { type: ["string", "null"], description: "תאריך החשבונית YYYY-MM-DD" },
  },
  required: ["amount", "client_name", "date"],
  additionalProperties: false,
};

// EZcount greeting → client_id in the app
const CLIENT_MATCHERS: [string, string][] = [
  ["ירושלים", "jlm"],
  ["ראשון לציון", "rl"],
  ["בית שמש", "bs"],
  ["גוש עציון", "ge"],
  ["אפרת", "ef"],
  ["נס ציונה", "nc"],
  ["קרית גת", "kg"],
];

function guessClientId(text: string): string | null {
  for (const [needle, id] of CLIENT_MATCHERS) {
    if (text.includes(needle)) return id;
  }
  return null;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

async function createInvoice(row: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/invoices`, {
    method: "POST",
    headers: { ...sbHeaders, "Prefer": "return=minimal" },
    body: JSON.stringify(row),
  });
}

async function askClaude(schema: object, content: any[], results: string[]): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    results.push(`❌ Anthropic API ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return null;
  }
  try {
    const text = (data.content || []).find((b: any) => b.type === "text")?.text || "{}";
    return JSON.parse(text);
  } catch { return null; }
}

async function extractPaymentInfo(pdfBase64: string, emailBody: string, results: string[]): Promise<any> {
  const content: any[] = [];
  if (pdfBase64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
  }
  content.push({
    type: "text",
    text: `זהו מסמך הודעת תשלום/זיכוי מעירייה לספק. חלץ את פרטי התשלום כולל פירוט לכל חשבונית.\nתוכן המייל: ${emailBody.slice(0, 800)}`
  });
  return await askClaude(PAYMENT_SCHEMA, content, results);
}

async function sendNotification(token: string, subject: string, body: string) {
  await fetch(`https://graph.microsoft.com/v1.0/users/${NOTIFY_EMAIL}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: `[סוכן ארזים] ${subject}`,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: NOTIFY_EMAIL } }]
      }
    })
  }).catch(() => {});
}

// ── EZcount: create/complete the invoice row and attach its PDF ──
async function processEZcountEmail(token: string, mailbox: string, email: any, invoices: any[], results: string[], digest: string[]): Promise<string> {
  const subject = email.subject || "";
  const bodyHtml = email.body?.content || "";
  const invInfo = extractInvoiceFromSubject(subject);
  if (!invInfo) return "no_invoice_in_subject";

  const { number: invNum, type: invType } = invInfo;
  // הצעות מחיר וקבלות לא מנוהלות בטבלה
  if (invType === "הצעת מחיר" || invType === "קבלה") return "skipped_type";

  const matched = invoices.find((inv: any) => {
    const n = String(inv.invoice_number || "").trim();
    return n === invNum || n.replace(/^0+/, "") === invNum.replace(/^0+/, "");
  });
  if (matched && matched.file_url && matched.amount != null) return "complete";

  // fetch the PDF (link in body, or attachment)
  let pdfBytes: Uint8Array | null = null;
  const pdfLink = extractPDFLink(bodyHtml);
  if (pdfLink) pdfBytes = await downloadPDF(pdfLink);
  if (!isPdf(pdfBytes) && email.hasAttachments) {
    const atts = await getAttachments(token, mailbox, email.id);
    if (atts.length && atts[0].contentBytes) {
      const b = Uint8Array.from(atob(atts[0].contentBytes), c => c.charCodeAt(0));
      if (isPdf(b)) pdfBytes = b;
    }
  }

  // extract amount/client/date from the PDF when we need them
  let extracted: any = null;
  if (pdfBytes && (!matched || matched.amount == null)) {
    extracted = await askClaude(INVOICE_SCHEMA, [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: toB64(pdfBytes) } },
      { type: "text", text: `זו ${invType} שהופקה ב-EZcount. חלץ את הסכום לפני מע"מ, שם הלקוח והתאריך.` },
    ], results);
  }

  if (!matched) {
    const clientGuess = guessClientId(bodyHtml) || "";
    const newId = uid();
    const filePath = pdfBytes ? await uploadToStorage(newId, pdfBytes) : null;
    const newRow = {
      id: newId,
      invoice_number: invNum,
      invoice_type: invType,
      amount: extracted?.amount ?? null,
      entity: "עוסק",
      date_sent: extracted?.date || (email.sentDateTime || "").slice(0, 10) || null,
      status: "sent",
      notes: `⚠️ נוצר אוטומטית מהמייל — יש לשייך לפרויקט${clientGuess ? ` (לקוח משוער: ${clientGuess})` : ""}`,
      file_url: filePath,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await createInvoice(newRow);
    invoices.push(newRow); // keep the in-memory list current for later emails in this run
    results.push(`🆕 ${invType} ${invNum} נוצרה (₪${extracted?.amount ?? "?"})`);
    digest.push(`🆕 ${invType} ${invNum} על סך ₪${extracted?.amount ?? "לא זוהה"} נוספה לטבלה — לשיוך לפרויקט`);
    return "auto_created";
  }

  // complete an existing row: attach PDF and/or backfill a missing amount
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let changed = false;
  if (!matched.file_url && pdfBytes) {
    const filePath = await uploadToStorage(matched.id, pdfBytes);
    if (filePath) { patch.file_url = filePath; matched.file_url = filePath; changed = true; }
  }
  if (matched.amount == null && extracted?.amount != null) {
    patch.amount = extracted.amount; matched.amount = extracted.amount; changed = true;
  }
  if (changed) {
    await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${matched.id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, "Prefer": "return=minimal" },
      body: JSON.stringify(patch),
    });
    results.push(`✅ ${invType} ${invNum} — ${patch.file_url ? "PDF צורף" : ""}${patch.amount != null ? " סכום הושלם ₪" + patch.amount : ""}`);
    digest.push(`✅ ${invType} ${invNum} הושלמה${patch.amount != null ? ` (₪${patch.amount})` : ""}`);
    return "completed";
  }
  results.push(`⚠️ ${invNum} — PDF לא הורד`);
  return "pdf_download_failed";
}

// ── Municipality payment notice: mark invoices as paid ──
async function processPaymentEmail(token: string, mailbox: string, email: any, invoices: any[], results: string[], digest: string[]): Promise<string> {
  const body = email.body?.content || "";
  let pdfB64 = "";
  if (email.hasAttachments) {
    const atts = await getAttachments(token, mailbox, email.id);
    if (atts.length && atts[0].contentBytes) pdfB64 = atts[0].contentBytes;
  }
  const info = await extractPaymentInfo(pdfB64, body, results);

  if (!info?.invoices?.length) {
    digest.push(`⚠️ מייל תשלום מ-${fromAddress(email)} — לא זוהה מספר חשבונית, בדוק ידנית (נושא: ${email.subject})`);
    return "no_invoice_numbers";
  }

  const updated: string[] = [], created: string[] = [];
  for (const item of info.invoices) {
    const n = String(item.number || "").trim();
    if (!n) continue;
    const s = n.replace(/^0+/, "");
    const m = invoices.find((inv: any) => {
      const num = String(inv.invoice_number || "").trim();
      return num === n || num.replace(/^0+/, "") === s;
    });
    if (m && m.status !== "paid") {
      await updateInvoiceStatus(m.id, info.payment_date);
      updated.push(`${s} (₪${item.amount ?? "?"})`);
    } else if (m) {
      updated.push(`${s} (כבר מסומנת כשולמה)`);
    } else {
      // invoice was never entered — create it as paid so the books stay complete
      const newRow = {
        id: uid(),
        invoice_number: s,
        invoice_type: "חשבון עסקה",
        amount: item.amount ?? null,
        // המוטב בהודעת התשלום קובע את הישות (עוסק מורשה / מ.ס ארזים הנדסה בע"מ)
        entity: info.payee_entity || "עוסק",
        date_paid: info.payment_date || new Date().toISOString().slice(0, 10),
        status: "paid",
        notes: `⚠️ נוצר אוטומטית מהודעת תשלום של ${info.payer || "העירייה"} — יש לשייך לפרויקט`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await createInvoice(newRow);
      invoices.push(newRow); // keep the in-memory list current for later emails in this run
      created.push(`${s} (₪${item.amount ?? "?"})`);
    }
  }

  let msg = `💰 תשלום מ-${info.payer || fromAddress(email)} בסך ₪${info.total_amount} (${info.payment_date})${info.payee_entity ? ` — לישות: ${info.payee_entity}` : ""}`;
  if (updated.length) msg += `\n   ✅ עודכנו לשולם: ${updated.join(", ")}`;
  if (created.length) msg += `\n   🆕 נוצרו כשולמו (לשיוך לפרויקט): ${created.join(", ")}`;
  digest.push(msg);
  results.push(`תשלום ${info.payer || ""}: עודכנו ${updated.length}, נוצרו ${created.length}`);
  return `payment_u${updated.length}_c${created.length}`;
}

// ── MAIN ──
Deno.serve(async () => {
  const results: string[] = [];
  const digest: string[] = []; // ONE summary email per run instead of one per event
  let hadError = false;
  let token: string | null = null;
  try {
    token = await getAzureToken();
    const [invoices, processed] = await Promise.all([getInvoices(), getProcessedIds()]);
    const seenThisRun = new Set<string>();

    for (const mailbox of MAILBOXES) {
      const emails = await getEmails(token, mailbox, results);
      for (const email of emails) {
        const key = messageKey(email);
        if (processed.has(key) || seenThisRun.has(key)) continue;
        const sender = fromAddress(email);

        let outcome: string | null = null;
        if (sender === EZCOUNT_SENDER) {
          outcome = await processEZcountEmail(token, mailbox, email, invoices, results, digest);
        } else if (PAYMENT_SENDERS.includes(sender)) {
          outcome = await processPaymentEmail(token, mailbox, email, invoices, results, digest);
        }
        if (outcome) {
          seenThisRun.add(key);
          await markProcessed(email, mailbox, outcome);
        }
      }
    }
  } catch (err: any) {
    hadError = true;
    results.push(`שגיאה: ${err.message}`);
    digest.push(`❌ שגיאה בסוכן: ${err.message}`);
  }

  if (token && digest.length) {
    await sendNotification(token,
      `סיכום פעילות — ${digest.length} עדכונים`,
      digest.join("\n\n") + `\n\n──\nצפה באפליקציה: https://arazim-eng.github.io/management`
    );
  }

  return new Response(JSON.stringify({ ok: !hadError, results }, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
});
