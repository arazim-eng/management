import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Weekly email to each גורם מטפל: their projects still missing a work order + the money stuck.
// Recipients come from the `handlers` table (email + send_weekly) — no email ⇒ nothing is sent.
// ?test=1 ⇒ every email is delivered to MOSHE only (subject marked), nothing reaches the handlers.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AZURE_TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const AZURE_CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const AZURE_CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;

const SENDER = "moshe@arazim-eng.co.il";
const MOSHE = "moshe@arazim-eng.co.il";
const VAT = 0.18; // project amounts are stored WITHOUT VAT (since 21.7.26)

const CLIENT_NAMES: Record<string, string> = {
  jlm: "עיריית ירושלים", rl: "עיריית ראשון לציון", bs: "עיריית בית שמש",
  ge: "גוש עציון", ef: "אפרת", nc: "נס ציונה", kg: "קרית גת",
};

function fc(n: any): string {
  if (!n && n !== 0) return "—";
  const x = Math.round(Number(n));
  if (isNaN(x)) return "—";
  return "₪" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const norm = (v: any) => String(v || "").trim().replace(/\s+/g, " ");

async function getAzureToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AZURE_CLIENT_ID,
      client_secret: AZURE_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = await res.json();
  return data.access_token;
}

async function sendEmail(token: string, to: string, cc: string | null, subject: string, htmlBody: string) {
  const message: any = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (cc && cc !== to) message.ccRecipients = [{ emailAddress: { address: cc } }];
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${await res.text()}`);
}

async function getData() {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const [projRes, handRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/projects?select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/handlers?select=*`, { headers }),
  ]);
  return { projects: await projRes.json(), handlers: await handRes.json() };
}

function buildHandlerEmail(name: string, projs: any[]): string {
  const dateStr = new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });
  const totalNet = projs.reduce((s, p) => s + (Number(p.supervision_amount) || 0), 0);
  const totalGross = Math.round(totalNet * (1 + VAT));

  let rows = "";
  projs.forEach((p) => {
    const net = Number(p.supervision_amount) || 0;
    const statusLabel = p.status === "pending_order" ? "הובטחה הזמנה — טרם הוצאה" : "ממתין להזמנת עבודה";
    const badge = p.status === "pending_order" ? "badge-amber" : "badge-red";
    rows += `<tr>
      <td><strong>${p.name}</strong>${p.project_number ? `<div style="font-size:11px;color:#888">${p.project_number}</div>` : ""}</td>
      <td>${CLIENT_NAMES[p.client_id] || p.custom_client || p.client_id || "—"}</td>
      <td>${p.scope_amount ? fc(p.scope_amount) : "—"}</td>
      <td><strong>${fc(net)}</strong></td>
      <td>${fc(Math.round(net * (1 + VAT)))}</td>
      <td><span class="badge ${badge}">${statusLabel}</span></td>
    </tr>`;
  });

  const style = `
    body { font-family: Arial, sans-serif; direction: rtl; background: #f0eeea; margin: 0; padding: 20px; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .header { background: #1860a8; color: white; padding: 20px 24px; border-radius: 10px 10px 0 0; }
    .header h1 { margin: 0; font-size: 19px; }
    .header p { margin: 4px 0 0; font-size: 13px; opacity: .85; }
    .body { background: white; border: 1px solid #ddd; border-top: none; border-radius: 0 0 10px 10px; padding: 24px; }
    p.intro { font-size: 14px; line-height: 1.6; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 14px; }
    th { background: #faf8f5; padding: 8px 10px; text-align: right; font-weight: 700; color: #888; border-bottom: 2px solid #eee; white-space: nowrap; }
    td { padding: 9px 10px; border-bottom: 1px solid #f0eeea; vertical-align: top; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .badge-red { background: #fce9e9; color: #7a0000; }
    .badge-amber { background: #faebd8; color: #5a3200; }
    .total-row td { background: #faf8f5; font-weight: 700; border-top: 2px solid #ddd; }
    .footer { text-align: center; font-size: 11px; color: #aaa; margin-top: 16px; }
  `;

  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>${style}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>⚠️ פרויקטים הממתינים להזמנת עבודה</h1>
    <p>מ.ס ארזים הנדסה · ${dateStr}</p>
  </div>
  <div class="body">
    <p class="intro">שלום ${name},<br>
    להלן ריכוז הפרויקטים שבטיפולך אשר טרם הוצאה עבורם הזמנת עבודה.
    נודה לקידום הוצאת ההזמנות כדי שנוכל להמשיך בעבודה באופן סדיר.</p>
    <table>
      <thead><tr><th>פרויקט</th><th>רשות</th><th>היקף (ללא מע"מ)</th><th>שכ"ט פיקוח (ללא מע"מ)</th><th>כולל מע"מ</th><th>סטטוס</th></tr></thead>
      <tbody>
        ${rows}
        <tr class="total-row"><td colspan="3">סה"כ (${projs.length} פרויקטים)</td><td>${fc(totalNet)}</td><td>${fc(totalGross)}</td><td></td></tr>
      </tbody>
    </table>
    <p class="intro" style="margin-top:18px">בכל שאלה ניתן לפנות אליי במייל או בטלפון.<br>תודה רבה,<br><strong>משה סעדה</strong> · מ.ס ארזים הנדסה בע"מ</p>
  </div>
  <div class="footer">נשלח אוטומטית ממערכת ניהול הפיקוח של ארזים הנדסה</div>
</div></body></html>`;
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const isTest = url.searchParams.get("test") === "1";

    const { projects, handlers } = await getData();

    // group open no-order projects by normalized handler name
    const byHandler: Record<string, { name: string; projs: any[] }> = {};
    projects.forEach((p: any) => {
      if (p.status !== "no_order" && p.status !== "pending_order") return;
      const n = norm(p.contact_name);
      if (!n) return;
      const k = n.toLowerCase();
      if (!byHandler[k]) byHandler[k] = { name: n, projs: [] };
      byHandler[k].projs.push(p);
    });

    const emailByName: Record<string, { email: string | null; send: boolean }> = {};
    (handlers || []).forEach((h: any) => {
      emailByName[norm(h.name).toLowerCase()] = { email: h.email || null, send: h.send_weekly !== false };
    });

    let token: string | null = null;
    let sent = 0, skipped = 0;
    const results: any[] = [];

    for (const k of Object.keys(byHandler)) {
      const { name, projs } = byHandler[k];
      const rec = emailByName[k];
      if (!rec || !rec.email || !rec.send) { skipped++; results.push({ handler: name, status: "no-email" }); continue; }
      if (!token) token = await getAzureToken();
      const html = buildHandlerEmail(name, projs);
      const subject = (isTest ? `[בדיקה — היה נשלח אל ${name} <${rec.email}>] ` : "") +
        `פרויקטים הממתינים להזמנת עבודה (${projs.length}) — ארזים הנדסה`;
      const to = isTest ? MOSHE : rec.email;
      const cc = isTest ? null : MOSHE;
      await sendEmail(token, to, cc, subject, html);
      sent++;
      results.push({ handler: name, to, projects: projs.length, status: "sent" });
    }

    return new Response(JSON.stringify({ ok: true, test: isTest, sent, skipped, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      headers: { "Content-Type": "application/json" },
    });
  }
});
