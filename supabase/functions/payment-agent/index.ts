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
  return data.access_token;
}

async function getEmails(token: string, mailbox: string, sender: string, folder = "inbox") {
  const folderPath = folder === "junk" ? "junkemail" : "inbox";
  const url = `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/${folderPath}/messages?` +
    `$filter=from/emailAddress/address eq '${sender}' and isRead eq false` +
    `&$select=id,subject,from,receivedDateTime,body,hasAttachments` +
    `&$top=20&$orderby=receivedDateTime desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.value || [];
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

async function markAsRead(token: string, mailbox: string, messageId: string) {
  await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true })
    }
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

function extractPDFLink(body: string): string | null {
  const match = body.match(/https:\/\/files\.ezcount\.co\.il\/front\/documents\/get\/[^\s"'<>&]+/);
  return match ? match[0] : null;
}

async function downloadPDF(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch { return null; }
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
  return `${SUPABASE_URL}/storage/v1/object/public/invoices/${path}`;
}

async function getInvoices() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/invoices?select=*`, {
    headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
  });
  return await res.json();
}

async function updateInvoicePDF(invoiceId: string, fileUrl: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoiceId}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify({ file_url: fileUrl, updated_at: new Date().toISOString() })
  });
}

async function updateInvoiceStatus(invoiceId: string, paymentDate: string) {
  await fetch(`${SUPABASE_URL}/rest/v1/invoices?id=eq.${invoiceId}`, {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify({ status: "paid", date_paid: paymentDate, updated_at: new Date().toISOString() })
  });
}

async function extractPaymentInfo(pdfBase64: string, emailBody: string): Promise<any> {
  const content: any[] = [];
  if (pdfBase64) {
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
  }
  content.push({
    type: "text",
    text: `זהו מסמך תשלום מעירייה. חלץ ב-JSON בלבד:
{"invoice_numbers":["מספרי חשבוניות"],"total_amount":"סכום","payment_date":"YYYY-MM-DD","payer":"שם"}
תוכן: ${emailBody.slice(0, 500)}`
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content }] })
  });
  const data = await res.json();
  try { return JSON.parse((data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim()); }
  catch { return null; }
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
  });
}

// ── EZcount: PDF attachment agent ──
async function processEZcount(token: string, results: string[]) {
  const invoices = await getInvoices();

  for (const mailbox of MAILBOXES) {
    for (const folder of ["inbox", "junk"]) {
      const emails = await getEmails(token, mailbox, EZCOUNT_SENDER, folder);
      if (emails.length) results.push(`EZcount ${folder} (${mailbox}): ${emails.length} מיילים`);

      for (const email of emails) {
        const subject = email.subject || "";
        const bodyHtml = email.body?.content || "";
        const invInfo = extractInvoiceFromSubject(subject);

        if (!invInfo) {
          await markAsRead(token, mailbox, email.id);
          continue;
        }

        const { number: invNum, type: invType } = invInfo;

        const matched = invoices.find((inv: any) => {
          const n = String(inv.invoice_number || "").trim();
          return n === invNum || n.replace(/^0+/, "") === invNum.replace(/^0+/, "");
        });

        let pdfUrl: string | null = null;

        // Try download link
        const pdfLink = extractPDFLink(bodyHtml);
        if (pdfLink && matched) {
          const bytes = await downloadPDF(pdfLink);
          if (bytes) pdfUrl = await uploadToStorage(matched.id, bytes);
        }

        // Try attachment
        if (!pdfUrl && matched) {
          const atts = await getAttachments(token, mailbox, email.id);
          if (atts.length && atts[0].contentBytes) {
            const bytes = Uint8Array.from(atob(atts[0].contentBytes), c => c.charCodeAt(0));
            pdfUrl = await uploadToStorage(matched.id, bytes);
          }
        }

        if (matched && pdfUrl) {
          await updateInvoicePDF(matched.id, pdfUrl);
          results.push(`✅ EZcount: ${invType} ${invNum} — PDF צורף`);
          await sendNotification(token,
            `📎 PDF צורף אוטומטית — ${invType} ${invNum}`,
            `${invType} מספר ${invNum} הורדה מ-EZcount וצורפה לאפליקציה אוטומטית.\n\nצפה באפליקציה: https://arazim-eng.github.io/management`
          );
        } else if (matched) {
          results.push(`⚠️ EZcount: ${invNum} — PDF לא הורד`);
        } else {
          results.push(`❌ EZcount: ${invType} ${invNum} — לא נמצאה בטבלה`);
          await sendNotification(token,
            `⚠️ EZcount: חשבונית לא נמצאה בטבלה`,
            `${invType} מספר ${invNum} התקבלה מ-EZcount אך לא נמצאה בטבלה.\n\nנושא: ${subject}\n\nבדוק ידנית באפליקציה.`
          );
        }

        await markAsRead(token, mailbox, email.id);
      }
    }
  }
}

// ── Payments: status update agent ──
async function processPayments(token: string, results: string[]) {
  const invoices = await getInvoices();

  for (const mailbox of MAILBOXES) {
    for (const sender of PAYMENT_SENDERS) {
      const emails = await getEmails(token, mailbox, sender);
      if (emails.length) results.push(`תשלום (${mailbox}): ${emails.length} מיילים`);

      for (const email of emails) {
        const atts = await getAttachments(token, mailbox, email.id);
        const body = email.body?.content || "";
        let info = null;

        if (atts.length) info = await extractPaymentInfo(atts[0].contentBytes, body);
        else info = await extractPaymentInfo("", body);

        if (!info?.invoice_numbers?.length) {
          await sendNotification(token, `⚠️ לא זוהה מספר חשבונית`, `מייל מ-${sender}\nנושא: ${email.subject}`);
          await markAsRead(token, mailbox, email.id);
          continue;
        }

        const updated: string[] = [], notFound: string[] = [];
        for (const n of info.invoice_numbers) {
          const m = invoices.find((inv: any) => {
            const num = String(inv.invoice_number || "").trim();
            const s = String(n).trim().replace(/^0+/, "");
            return num === n || num.replace(/^0+/, "") === s || num.endsWith(s);
          });
          if (m) { await updateInvoiceStatus(m.id, info.payment_date); updated.push(`${n} (₪${info.total_amount})`); }
          else notFound.push(n);
        }

        let msg = `שולם ע"י: ${info.payer || sender}\nתאריך: ${info.payment_date}\nסכום: ₪${info.total_amount}\n\n`;
        if (updated.length) msg += `✅ עודכנו לשולם:\n${updated.join("\n")}\n\n⚠️ זכור להוציא קבלה!\n`;
        if (notFound.length) msg += `❌ לא נמצאו:\n${notFound.join("\n")}`;

        await sendNotification(token, updated.length ? `✅ תשלום התקבל` : `❌ חשבוניות לא נמצאו`, msg);
        await markAsRead(token, mailbox, email.id);
        results.push(`תשלום: עודכנו ${updated.length}, לא נמצאו ${notFound.length}`);
      }
    }
  }
}

// ── MAIN ──
Deno.serve(async () => {
  const results: string[] = [];
  try {
    const token = await getAzureToken();
    await processEZcount(token, results);
    await processPayments(token, results);
  } catch (err: any) {
    results.push(`שגיאה: ${err.message}`);
  }
  return new Response(JSON.stringify({ ok: true, results }, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
});
