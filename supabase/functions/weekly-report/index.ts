import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AZURE_TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const AZURE_CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const AZURE_CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;

const RECIPIENTS = [
  "moshe@arazim-eng.co.il",
  "office@arazim-eng.co.il"
];

const SENDER = "moshe@arazim-eng.co.il";

const CLIENT_NAMES: Record<string, string> = {
  jlm: "עיריית ירושלים",
  rl:  "עיריית ראשון לציון",
  bs:  "עיריית בית שמש",
  ge:  "גוש עציון",
  ef:  "אפרת",
  nc:  "נס ציונה",
  kg:  "קרית גת",
};

function fc(n: any): string {
  if (!n && n !== 0) return "—";
  const x = Math.round(Number(n));
  if (isNaN(x)) return "—";
  return "₪" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fd(d: any): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("he-IL"); } catch { return d; }
}

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

async function sendEmail(token: string, subject: string, htmlBody: string) {
  const toRecipients = RECIPIENTS.map(addr => ({
    emailAddress: { address: addr }
  }));

  await fetch(`https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: htmlBody },
        toRecipients
      }
    })
  });
}

async function getData() {
  const [projRes, invRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/projects?select=*`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    }),
    fetch(`${SUPABASE_URL}/rest/v1/invoices?select=*`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    })
  ]);
  const projects = await projRes.json();
  const invoices = await invRes.json();
  return { projects, invoices };
}

function buildReport(projects: any[], invoices: any[]): string {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateStr = now.toLocaleDateString("he-IL", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  // ── Section 1: שולם + אין חשבונית מס ──
  const paidNoTax: any[] = [];
  invoices.forEach(inv => {
    if (inv.invoice_type === "חשבון עסקה" && inv.status === "paid") {
      const hasTax = invoices.find(i => i.closes_id === inv.id);
      if (!hasTax) {
        const proj = projects.find(p => p.id === inv.project_id);
        paidNoTax.push({ inv, proj });
      }
    }
  });

  // ── Section 2: ללא הזמנת עבודה / ממתין להזמנה ──
  const needWO = projects.filter(p =>
    p.status !== "closed" && (p.status === "no_order" || p.status === "pending_order")
  );

  // ── Section 3: שולם השבוע ──
  const paidThisWeek = invoices.filter(inv => {
    if (inv.status !== "paid" || !inv.date_paid) return false;
    return new Date(inv.date_paid) >= weekAgo;
  });

  // ── Section 4: פרויקטים פעילים ──
  const active = projects.filter(p => p.status !== "closed");

  // ── Build HTML ──
  const style = `
    body { font-family: Arial, sans-serif; direction: rtl; background: #f0eeea; margin: 0; padding: 20px; }
    .wrap { max-width: 700px; margin: 0 auto; }
    .header { background: #1860a8; color: white; padding: 20px 24px; border-radius: 10px 10px 0 0; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p { margin: 4px 0 0; font-size: 13px; opacity: .8; }
    .body { background: white; border: 1px solid #ddd; border-top: none; border-radius: 0 0 10px 10px; padding: 24px; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 15px; font-weight: 700; margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; }
    .s1 { background: #fce9e9; color: #7a0000; }
    .s2 { background: #faebd8; color: #5a3200; }
    .s3 { background: #e9f3dc; color: #3a6b10; }
    .s4 { background: #e8f1fb; color: #1860a8; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #faf8f5; padding: 8px 10px; text-align: right; font-weight: 700; color: #888; border-bottom: 2px solid #eee; }
    td { padding: 8px 10px; border-bottom: 1px solid #f0eeea; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .empty { color: #aaa; font-size: 13px; padding: 10px 0; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .badge-red { background: #fce9e9; color: #7a0000; }
    .badge-amber { background: #faebd8; color: #5a3200; }
    .badge-green { background: #e9f3dc; color: #3a6b10; }
    .footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 16px; }
    .total-row { background: #faf8f5; font-weight: 700; }
  `;

  // Section 1 HTML
  let s1 = `<div class="section">
    <div class="section-title s1">🧾 שולם — דרושה הוצאת חשבונית מס (${paidNoTax.length})</div>`;
  if (!paidNoTax.length) {
    s1 += `<div class="empty">✅ אין חשבונות עסקה ממתינים לחשבונית מס</div>`;
  } else {
    s1 += `<table><thead><tr><th>מספר חשבונית</th><th>פרויקט</th><th>לקוח</th><th>סכום</th><th>תאריך תשלום</th></tr></thead><tbody>`;
    paidNoTax.forEach(({ inv, proj }) => {
      s1 += `<tr>
        <td><strong>${inv.invoice_number || "—"}</strong></td>
        <td>${proj?.name || "—"}</td>
        <td>${CLIENT_NAMES[proj?.client_id] || proj?.custom_client || proj?.client_id || "—"}</td>
        <td><strong>${fc(inv.amount)}</strong></td>
        <td>${fd(inv.date_paid)}</td>
      </tr>`;
    });
    s1 += `</tbody></table>`;
  }
  s1 += `</div>`;

  // Section 2 HTML
  let s2 = `<div class="section">
    <div class="section-title s2">⚠️ פרויקטים ללא הזמנת עבודה (${needWO.length})</div>`;
  if (!needWO.length) {
    s2 += `<div class="empty">✅ כל הפרויקטים קיבלו הזמנת עבודה</div>`;
  } else {
    s2 += `<table><thead><tr><th>פרויקט</th><th>לקוח</th><th>איש קשר</th><th>סכום פיקוח (ללא מע"מ)</th><th>סטטוס</th></tr></thead><tbody>`;
    needWO.forEach(p => {
      const statusLabel = p.status === "no_order" ? "ללא הזמנה" : "ממתין להזמנה";
      const badgeClass = p.status === "no_order" ? "badge-red" : "badge-amber";
      s2 += `<tr>
        <td><strong>${p.name}</strong></td>
        <td>${CLIENT_NAMES[p.client_id] || p.custom_client || p.client_id || "—"}</td>
        <td>${p.contact_name || "—"}</td>
        <td>${fc(p.supervision_amount)}</td>
        <td><span class="badge ${badgeClass}">${statusLabel}</span></td>
      </tr>`;
    });
    s2 += `</tbody></table>`;
  }
  s2 += `</div>`;

  // ── Section 2.5: ממתין לפי גורם מטפל ──
  const norm = (v: any) => String(v || "").trim().replace(/\s+/g, " ");
  const byHandler: Record<string, { name: string; noOrdCnt: number; noOrdSum: number; pendCnt: number; pendSum: number }> = {};
  const pidHandler: Record<string, string> = {};
  projects.forEach(p => {
    const n = norm(p.contact_name);
    if (n) pidHandler[p.id] = n;
    if (!n || p.status === "closed") return;
    const k = n.toLowerCase();
    if (!byHandler[k]) byHandler[k] = { name: n, noOrdCnt: 0, noOrdSum: 0, pendCnt: 0, pendSum: 0 };
    if (p.status === "no_order" || p.status === "pending_order") {
      byHandler[k].noOrdCnt++;
      byHandler[k].noOrdSum += Number(p.supervision_amount) || 0;
    }
  });
  invoices.forEach(inv => {
    if (inv.status !== "sent" && inv.status !== "accounting") return;
    const n = pidHandler[inv.project_id];
    if (!n) return;
    const k = n.toLowerCase();
    if (!byHandler[k]) byHandler[k] = { name: n, noOrdCnt: 0, noOrdSum: 0, pendCnt: 0, pendSum: 0 };
    byHandler[k].pendCnt++;
    byHandler[k].pendSum += Number(inv.amount) || 0;
  });
  const handlers = Object.values(byHandler)
    .filter(e => e.noOrdCnt || e.pendCnt)
    .sort((a, b) => (b.noOrdSum + b.pendSum) - (a.noOrdSum + a.pendSum));
  let s25 = `<div class="section"><div class="section-title s2">👤 ממתין לפי גורם מטפל (${handlers.length})</div>`;
  if (!handlers.length) {
    s25 += `<div class="empty">✅ אין פריטים פתוחים לפי גורם</div>`;
  } else {
    s25 += `<table><thead><tr><th>גורם מטפל</th><th>ממתין להזמנה</th><th>הוגש וטרם שולם</th><th>סה"כ חשיפה</th></tr></thead><tbody>`;
    handlers.forEach(e => {
      s25 += `<tr>
        <td><strong>${e.name}</strong></td>
        <td>${e.noOrdCnt ? `${e.noOrdCnt} | ${fc(e.noOrdSum)}` : "—"}</td>
        <td>${e.pendCnt ? `${e.pendCnt} | ${fc(e.pendSum)}` : "—"}</td>
        <td><strong style="color:#7a0000">${fc(e.noOrdSum + e.pendSum)}</strong></td>
      </tr>`;
    });
    s25 += `</tbody></table>`;
  }
  s25 += `</div>`;

  // Section 3 HTML
  const totalPaid = paidThisWeek.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  let s3 = `<div class="section">
    <div class="section-title s3">✅ שולם השבוע (${paidThisWeek.length} חשבוניות | ${fc(totalPaid)})</div>`;
  if (!paidThisWeek.length) {
    s3 += `<div class="empty">לא התקבלו תשלומים השבוע</div>`;
  } else {
    s3 += `<table><thead><tr><th>מספר חשבונית</th><th>פרויקט</th><th>לקוח</th><th>סכום</th><th>תאריך תשלום</th></tr></thead><tbody>`;
    paidThisWeek.forEach(inv => {
      const proj = projects.find(p => p.id === inv.project_id);
      s3 += `<tr>
        <td><strong>${inv.invoice_number || "—"}</strong></td>
        <td>${proj?.name || "—"}</td>
        <td>${CLIENT_NAMES[proj?.client_id] || proj?.custom_client || proj?.client_id || "—"}</td>
        <td><strong style="color:#3a6b10">${fc(inv.amount)}</strong></td>
        <td>${fd(inv.date_paid)}</td>
      </tr>`;
    });
    s3 += `<tr class="total-row"><td colspan="3">סה"כ</td><td style="color:#3a6b10">${fc(totalPaid)}</td><td></td></tr>`;
    s3 += `</tbody></table>`;
  }
  s3 += `</div>`;

  // Section 4 HTML
  const totalActive = active.reduce((s, p) => s + (Number(p.supervision_amount) || 0), 0);
  let s4 = `<div class="section">
    <div class="section-title s4">📋 פרויקטים פעילים (${active.length})</div>`;
  if (!active.length) {
    s4 += `<div class="empty">אין פרויקטים פעילים</div>`;
  } else {
    s4 += `<table><thead><tr><th>פרויקט</th><th>לקוח</th><th>סכום פיקוח (ללא מע"מ)</th><th>הוגש</th><th>שולם</th><th>סטטוס</th></tr></thead><tbody>`;
    
    const statusLabels: Record<string, string> = {
      no_order: "ללא הזמנה",
      pending_order: "ממתין להזמנה",
      offer_sent: "נשלח חשבון עסקה",
      accounting: "בהנה\"ח",
      paid: "שולם",
      invoice_sent: "נשלחה חשבונית מס",
    };

    active.forEach(p => {
      const projInvs = invoices.filter(i => i.project_id === p.id);
      const submitted = projInvs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const paid = projInvs.filter(i => i.status === "paid").reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const label = statusLabels[p.status] || p.status;
      s4 += `<tr>
        <td><strong>${p.name}</strong></td>
        <td>${CLIENT_NAMES[p.client_id] || p.custom_client || p.client_id || "—"}</td>
        <td>${fc(p.supervision_amount)}</td>
        <td>${submitted ? fc(submitted) : "—"}</td>
        <td>${paid ? `<span style="color:#3a6b10">${fc(paid)}</span>` : "—"}</td>
        <td><span style="font-size:12px">${label}</span></td>
      </tr>`;
    });
    s4 += `<tr class="total-row"><td colspan="2">סה"כ (${active.length} פרויקטים)</td><td style="color:#1860a8">${fc(totalActive)}</td><td colspan="3"></td></tr>`;
    s4 += `</tbody></table>`;
  }
  s4 += `</div>`;

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>${style}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>📊 דוח שבועי — ארזים הנדסה</h1>
    <p>${dateStr}</p>
  </div>
  <div class="body">
    ${s1}
    ${s2}
    ${s25}
    ${s3}
    ${s4}
  </div>
  <div class="footer">מערכת ניהול פיקוח ארזים הנדסה | <a href="https://arazim-eng.github.io/management">פתח אפליקציה</a></div>
</div></body></html>`;
}

Deno.serve(async () => {
  try {
    const token = await getAzureToken();
    const { projects, invoices } = await getData();
    const html = buildReport(projects, invoices);
    const now = new Date();
    const subject = `דוח שבועי ארזים הנדסה — ${now.toLocaleDateString("he-IL")}`;
    await sendEmail(token, subject, html);
    return new Response(JSON.stringify({ ok: true, message: "דוח נשלח בהצלחה" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      headers: { "Content-Type": "application/json" }
    });
  }
});
