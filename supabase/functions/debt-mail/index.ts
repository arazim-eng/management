import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Manual debt-report mail — triggered by Moshe from the app (מסך "דוח חובות"), NOT by the weekly agent.
// The browser builds the HTML (same document it prints to PDF) and posts it here; this function only
// authorises the recipients and hands the message to Microsoft Graph.
//
// Guard: a recipient is accepted only if it is one of the office addresses or an email that already
// exists in the `handlers` table. Nothing arbitrary can be mailed from this endpoint.
// The Supabase gateway enforces a valid JWT (verify_jwt = true), so only logged-in app users get here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AZURE_TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const AZURE_CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const AZURE_CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;

const SENDER = "moshe@arazim-eng.co.il";
const OFFICE = ["moshe@arazim-eng.co.il", "office@arazim-eng.co.il"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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
  if (!data.access_token) throw new Error("azure token failed");
  return data.access_token;
}

async function sendEmail(token: string, to: string[], subject: string, htmlBody: string) {
  const message = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
  };
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${SENDER}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${await res.text()}`);
}

async function allowedRecipients(): Promise<Set<string>> {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/handlers?select=email`, { headers });
  const rows = await res.json();
  const set = new Set(OFFICE.map((e) => e.toLowerCase()));
  (Array.isArray(rows) ? rows : []).forEach((h: any) => {
    if (h?.email) set.add(String(h.email).trim().toLowerCase());
  });
  return set;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const payload = await req.json();
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    if (!messages.length) return json({ ok: false, error: "no messages" }, 400);
    if (messages.length > 40) return json({ ok: false, error: "too many messages" }, 400);

    const allowed = await allowedRecipients();
    const cleaned: { to: string[]; subject: string; html: string }[] = [];
    for (const m of messages) {
      const to = (Array.isArray(m?.to) ? m.to : []).map((e: string) => String(e).trim()).filter(Boolean);
      if (!to.length || !m?.subject || !m?.html) return json({ ok: false, error: "bad message" }, 400);
      const bad = to.filter((e: string) => !allowed.has(e.toLowerCase()));
      if (bad.length) return json({ ok: false, error: `נמען לא מורשה: ${bad.join(", ")}` }, 403);
      cleaned.push({ to, subject: String(m.subject), html: String(m.html) });
    }

    const token = await getAzureToken();
    let sent = 0;
    const errors: string[] = [];
    for (const m of cleaned) {
      try {
        await sendEmail(token, m.to, m.subject, m.html);
        sent++;
      } catch (e: any) {
        errors.push(`${m.to.join(",")}: ${e.message}`);
      }
    }
    return json({ ok: true, sent, errors });
  } catch (err: any) {
    return json({ ok: false, error: err.message }, 500);
  }
});
