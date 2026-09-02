import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Weekly email per department/handler: projects still missing a work order + the money stuck.
// Routing rules (Moshe 21.7.26):
//   בדק בית  = קובי שמואלי + שלומי שוקרון → one email to both
//   תכנון    = תהילה ארז + סנדרה (+ תהילה חפצדי) → one email, תהילה ארז always included
//   נגישות   = לאה סנדרס + הדסה → one email to both, always
//   מוחמד / שמואל לשם / everyone else → individual email
// Recipients come from the `handlers` table (email + send_weekly) — no email ⇒ nothing is sent.
//
// ⚠️ כלל פרטיות (משה, 2.9.26) — אסור לשבור:
//   מייל לגורם בעירייה = אך ורק הפרויקטים שלו שטרם יצאה להם הזמנת עבודה.
//   כל מה שקשור לכסף שכבר הוגש — חשבוניות פתוחות, הנהלת חשבונות, ממתין לתשלום —
//   נכנס אך ורק ל-sumHtml שנשלח ל-SUMMARY_TO (משה + יפעה) ולעולם לא ל-buildHandlerEmail.
//   buildHandlerEmail מקבל projects בלבד, לא invoices — אל תעביר לו חשבוניות.
// ?test=1 ⇒ every email is delivered to MOSHE only (subject marked), nothing reaches the handlers.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AZURE_TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const AZURE_CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const AZURE_CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;

const SENDER = "moshe@arazim-eng.co.il";
const MOSHE = "moshe@arazim-eng.co.il";
const SUMMARY_TO = ["moshe@arazim-eng.co.il", "office@arazim-eng.co.il"]; // משה + יפעה
const VAT = 0.18; // project amounts are stored WITHOUT VAT (since 21.7.26)

const CLIENT_NAMES: Record<string, string> = {
  jlm: "עיריית ירושלים", rl: "עיריית ראשון לציון", bs: "עיריית בית שמש",
  ge: "גוש עציון", ef: "אפרת", nc: "נס ציונה", kg: "קרית גת",
};

// department groups — member projects are combined into ONE email sent to all members' addresses
const GROUPS: { title: string; members: string[] }[] = [
  // "תהילה + קובי" (פלך) belongs to BOTH בדק בית and תכנון — appears in both emails (Moshe 21.7)
  { title: "בדק בית", members: ["קובי שמואלי", "שלומי שוקרון", "תהילה + קובי"] },
  { title: "תכנון", members: ["תהילה ארז", "סנדרה", "תהילה חפצדי", "שלומי שוקרון", "תהילה + קובי"] },
  { title: "נגישות", members: ["לאה סנדרס", "הדסה", "שגיא עוזרי"] },
];

// גורמים שמקבלים את כל פרויקטי ירושלים ללא הזמנה — לא רק את אלה שהם מטפלים בהם (משה, 2.9.26)
const ALL_JLM: string[] = ["יפעת"];

// "הוגש וטרם שולם" — אותו כלל בדיוק כמו inCashflow באפליקציה:
// חשבונית מס פתוחה תמיד נספרת; חשבון עסקה רק אם יש הזמנה ואף חשבונית מס לא סגרה אותו.
function openInvoices(invoices: any[], projects: any[]) {
  const projById: Record<string, any> = {};
  projects.forEach((p) => { projById[p.id] = p; });
  const closed = new Set(invoices.map((i) => i.closes_id).filter(Boolean));
  return invoices.filter((i) => {
    if (i.exclude_cashflow) return false;
    if (i.status !== "sent" && i.status !== "accounting") return false;
    if (!Number(i.amount)) return false;
    if (i.invoice_type === "חשבונית מס") return true;
    if (i.invoice_type === "חשבון עסקה") {
      if (closed.has(i.id)) return false;
      const p = projById[i.project_id];
      return !!(p && String(p.work_order_number || "").trim());
    }
    return false;
  });
}

function fc(n: any): string {
  if (!n && n !== 0) return "—";
  const x = Math.round(Number(n));
  if (isNaN(x)) return "—";
  return "₪" + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const norm = (v: any) => String(v || "").trim().replace(/\s+/g, " ");
// a handler row may carry several comma-separated addresses — e.g. "תהילה + קובי" (פלך) mails both
const emails = (v: any): string[] =>
  String(v || "").split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);

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
  const [projRes, handRes, invRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/projects?select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/handlers?select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/invoices?select=*`, { headers }),
  ]);
  return { projects: await projRes.json(), handlers: await handRes.json(), invoices: await invRes.json() };
}

function buildHandlerEmail(greeting: string, projs: any[], showHandler: boolean): string {
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
      ${showHandler ? `<td>${norm(p.contact_name) || "—"}</td>` : ""}
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
    <p class="intro">שלום ${greeting},<br>
    להלן ריכוז הפרויקטים שבטיפולכם אשר טרם הוצאה עבורם הזמנת עבודה.
    נודה לקידום הוצאת ההזמנות כדי שנוכל להמשיך בעבודה באופן סדיר.</p>
    <table>
      <thead><tr><th>פרויקט</th>${showHandler ? "<th>גורם מטפל</th>" : ""}<th>רשות</th><th>היקף (ללא מע"מ)</th><th>שכ"ט פיקוח (ללא מע"מ)</th><th>כולל מע"מ</th><th>סטטוס</th></tr></thead>
      <tbody>
        ${rows}
        <tr class="total-row"><td colspan="${showHandler ? 4 : 3}">סה"כ (${projs.length} פרויקטים)</td><td>${fc(totalNet)}</td><td>${fc(totalGross)}</td><td></td></tr>
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

    const { projects, handlers, invoices } = await getData();

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
    const grouped = new Set<string>(); // handler keys already covered by a department email

    const sentDetails: { label: string; toList: string[]; projs: any[] }[] = [];
    const deliver = async (label: string, greeting: string, toList: string[], projs: any[], showHandler: boolean) => {
      if (!token) token = await getAzureToken();
      const html = buildHandlerEmail(greeting, projs, showHandler);
      const subject = (isTest ? `[בדיקה — היה נשלח אל ${toList.join(", ")}] ` : "") +
        `פרויקטים הממתינים להזמנת עבודה — ${label} (${projs.length})`;
      const recipients = isTest ? [MOSHE] : toList;
      for (let i = 0; i < recipients.length; i++) {
        await sendEmail(token!, recipients[i], null, subject, html);
        if (isTest) break; // in test mode one copy to Moshe is enough
      }
      sent++;
      sentDetails.push({ label, toList, projs });
      results.push({ group: label, to: toList, projects: projs.length, status: "sent" });
    };

    // 1) department groups — combined projects, all members as recipients
    for (const g of GROUPS) {
      const memberKeys = g.members.map((m) => norm(m).toLowerCase());
      const projs = memberKeys.flatMap((mk) => byHandler[mk]?.projs || []);
      memberKeys.forEach((mk) => { if (byHandler[mk]) grouped.add(mk); });
      if (!projs.length) continue;
      const toList = memberKeys
        .map((mk) => emailByName[mk])
        .filter((r) => r && r.email && r.send)
        .flatMap((r) => emails(r!.email));
      if (!toList.length) { skipped++; results.push({ group: g.title, status: "no-email" }); continue; }
      const names = g.members.filter((m) => {
        if (m.includes("+")) return false; // pseudo-member (shared handler) — not a greeting name
        const mk = norm(m).toLowerCase();
        return byHandler[mk] || (emailByName[mk] && emailByName[mk].email);
      });
      await deliver(`מחלקת ${g.title}`, names.join(" ו"), [...new Set(toList)], projs, true);
    }

    // 1.5) גורמים שמקבלים את כל ירושלים (יפעת) — לפני הבודדים, כדי שלא יקבלו גם מייל אישי
    for (const nm of ALL_JLM) {
      const k = norm(nm).toLowerCase();
      grouped.add(k);
      const rec = emailByName[k];
      if (!rec || !rec.email || !rec.send) { skipped++; results.push({ handler: nm, status: "no-email" }); continue; }
      const projs = projects.filter((p: any) =>
        (p.status === "no_order" || p.status === "pending_order") && p.client_id === "jlm");
      if (!projs.length) continue;
      await deliver(`${nm} — כל ירושלים`, nm, emails(rec.email), projs, true);
    }

    // 2) individual handlers (מוחמד, שמואל לשם and anyone else not in a group)
    for (const k of Object.keys(byHandler)) {
      if (grouped.has(k)) continue;
      const { name, projs } = byHandler[k];
      const rec = emailByName[k];
      if (!rec || !rec.email || !rec.send) { skipped++; results.push({ handler: name, status: "no-email" }); continue; }
      await deliver(name, name, emails(rec.email), projs, false);
    }

    // 3) combined summary to Moshe + Yifa — who got what, and the grand total
    if (sentDetails.length) {
      if (!token) token = await getAzureToken();
      // פלך appears in two groups — count unique projects for the grand total
      const uniq: Record<string, any> = {};
      sentDetails.forEach((d) => d.projs.forEach((p) => { uniq[p.id] = p; }));
      const uniqProjs = Object.values(uniq);
      const uniqTotal = uniqProjs.reduce((s: number, p: any) => s + (Number(p.supervision_amount) || 0), 0);
      let sumRows = "";
      sentDetails.forEach((d) => {
        const t = d.projs.reduce((s, p) => s + (Number(p.supervision_amount) || 0), 0);
        sumRows += `<tr><td><strong>${d.label}</strong></td><td style="font-size:12px">${d.toList.join("<br>")}</td><td>${d.projs.length}</td><td><strong>${fc(t)}</strong></td><td>${fc(Math.round(t * (1 + VAT)))}</td></tr>`;
      });
      let allRows = "";
      (uniqProjs as any[]).sort((a, b) => (Number(b.supervision_amount) || 0) - (Number(a.supervision_amount) || 0)).forEach((p) => {
        const net = Number(p.supervision_amount) || 0;
        allRows += `<tr><td><strong>${p.name}</strong></td><td>${norm(p.contact_name) || "—"}</td><td>${CLIENT_NAMES[p.client_id] || p.custom_client || p.client_id || "—"}</td><td>${fc(net)}</td><td>${fc(Math.round(net * (1 + VAT)))}</td></tr>`;
      });
      // חצי שני של הסיכום ליפעה: מה שכבר הוגש וטרם שולם
      const projById: Record<string, any> = {};
      projects.forEach((p: any) => { projById[p.id] = p; });
      const openInv = openInvoices(invoices || [], projects)
        .sort((a: any, b: any) => Number(b.amount) - Number(a.amount));
      const openTotal = openInv.reduce((s: number, i: any) => s + Number(i.amount || 0), 0);
      let invRows = "";
      openInv.forEach((i: any) => {
        const p = projById[i.project_id];
        const cl = p ? (CLIENT_NAMES[p.client_id] || p.custom_client || p.client_id || "—") : "—";
        invRows += `<tr><td><strong>${i.invoice_number || "—"}</strong><div style="font-size:11px;color:#888">${i.invoice_type || ""}</div></td>` +
          `<td>${p ? p.name : "<span style=\"color:#a4342a\">⚠️ ללא שיוך</span>"}</td>` +
          `<td>${p ? (norm(p.contact_name) || "—") : "—"}</td><td>${cl}</td>` +
          `<td>${i.date_sent || "—"}</td><td><strong>${fc(Number(i.amount))}</strong></td></tr>`;
      });
      const grand = uniqTotal + openTotal;
      const dateStr = new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });
      const sumHtml = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><style>
        body{font-family:Arial,sans-serif;direction:rtl;background:#f0eeea;margin:0;padding:20px}
        .wrap{max-width:720px;margin:0 auto}
        .header{background:#0e6d54;color:white;padding:20px 24px;border-radius:10px 10px 0 0}
        .header h1{margin:0;font-size:19px}.header p{margin:4px 0 0;font-size:13px;opacity:.85}
        .body{background:white;border:1px solid #ddd;border-top:none;border-radius:0 0 10px 10px;padding:24px}
        h2{font-size:14px;margin:18px 0 6px;color:#333}
        table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
        th{background:#faf8f5;padding:8px 10px;text-align:right;font-weight:700;color:#888;border-bottom:2px solid #eee;white-space:nowrap}
        td{padding:8px 10px;border-bottom:1px solid #f0eeea;vertical-align:top}
        .total-row td{background:#e0f4ed;font-weight:700;border-top:2px solid #9fe0cb;color:#074f3c}
        .footer{text-align:center;font-size:11px;color:#aaa;margin-top:16px}
      </style></head><body><div class="wrap">
        <div class="header"><h1>📊 סיכום שבועי — כל החוב הפתוח לארזים</h1><p>מ.ס ארזים הנדסה · ${dateStr}</p></div>
        <div class="body">
          <h2>מי קיבל מה</h2>
          <table><thead><tr><th>מחלקה / גורם</th><th>נמענים</th><th>פרויקטים</th><th>שכ"ט ללא מע"מ</th><th>כולל מע"מ</th></tr></thead>
          <tbody>${sumRows}
          <tr class="total-row"><td colspan="2">סה"כ (${uniqProjs.length} פרויקטים ייחודיים)</td><td></td><td>${fc(uniqTotal)}</td><td>${fc(Math.round(uniqTotal * (1 + VAT)))}</td></tr></tbody></table>
          <h2>כל הפרויקטים הממתינים להזמנה</h2>
          <table><thead><tr><th>פרויקט</th><th>גורם מטפל</th><th>רשות</th><th>שכ"ט ללא מע"מ</th><th>כולל מע"מ</th></tr></thead>
          <tbody>${allRows}</tbody></table>
          <h2>הוגש וטרם שולם — ${openInv.length} מסמכים</h2>
          <table><thead><tr><th>מסמך</th><th>פרויקט</th><th>גורם מטפל</th><th>רשות</th><th>נשלח</th><th>סכום</th></tr></thead>
          <tbody>${invRows}
          <tr class="total-row"><td colspan="5">סה"כ הוגש וטרם שולם</td><td>${fc(openTotal)}</td></tr></tbody></table>
          <h2>סך כל החוב לארזים</h2>
          <table><tbody>
            <tr><td>ממתין להזמנת עבודה (${uniqProjs.length} פרויקטים)</td><td style="text-align:left"><strong>${fc(uniqTotal)}</strong></td></tr>
            <tr><td>הוגש וטרם שולם (${openInv.length} מסמכים)</td><td style="text-align:left"><strong>${fc(openTotal)}</strong></td></tr>
            <tr class="total-row"><td>סך הכל</td><td style="text-align:left">${fc(grand)}</td></tr>
          </tbody></table>
        </div>
        <div class="footer">נשלח אוטומטית ממערכת ניהול הפיקוח של ארזים הנדסה</div>
      </div></body></html>`;
      const sumSubject = (isTest ? "[בדיקה] " : "") + `סיכום שבועי — ${fc(grand)} חוב פתוח לארזים (${fc(uniqTotal)} ללא הזמנה + ${fc(openTotal)} הוגש וטרם שולם)`;
      const sumTo = isTest ? [MOSHE] : SUMMARY_TO;
      for (const addr of sumTo) await sendEmail(token!, addr, null, sumSubject, sumHtml);
      results.push({ summary: true, to: sumTo, total: uniqTotal, status: "sent" });
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
