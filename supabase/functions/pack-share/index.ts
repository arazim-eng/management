import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Public "package of documents" page for municipality handlers (חבילת מסמכים).
// A handler opens a tokenized link from the debts email and gets an RTL page with
// every document of that debt (quote/עסקה, signed contractor account, BOQ, contractor
// invoice, extras) + a client-side "merge & print" button. No login required — access
// is granted solely by an unexpired random token in pack_shares (created from the app
// by a logged-in team member). Deployed with --no-verify-jwt.
//
// Documents live in the private `invoices` bucket; this function signs fresh 1-hour
// URLs on every page view, so the page keeps working for the token's lifetime while
// the underlying file URLs stay short-lived.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const H = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function rest(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return null;
  return await r.json();
}

async function signPath(path: string): Promise<string | null> {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/invoices/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "POST",
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );
  if (!r.ok) return null;
  const d = await r.json();
  return d.signedURL ? `${SUPABASE_URL}/storage/v1${d.signedURL}` : null;
}

const page = (title: string, body: string) =>
  new Response(
    `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${H(title)}</title><style>
body{font-family:Arial,sans-serif;direction:rtl;background:#f0eeea;margin:0;padding:20px;color:#1c1c1a}
.wrap{max-width:760px;margin:0 auto}
.header{background:#1860a8;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0}
.header h1{margin:0;font-size:19px}.header p{margin:4px 0 0;font-size:13px;opacity:.85}
.body{background:#fff;border:1px solid #ddd;border-top:none;border-radius:0 0 10px 10px;padding:24px}
.slot{border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px;margin-bottom:10px;background:#faf8f5}
.slot.ok{border-color:#bde090;background:#f6fbf0}
.slot h3{margin:0 0 6px;font-size:14px}
.doc{display:flex;align-items:center;gap:8px;font-size:13px;margin-top:6px}
.doc a{color:#1860a8;font-weight:600;text-decoration:none}
.missing{color:#a55;font-size:12px}
.btn{display:inline-block;background:#1860a8;color:#fff;border:none;border-radius:8px;padding:11px 22px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
.btn:disabled{opacity:.6;cursor:default}
.note{font-size:12px;color:#888;margin-top:14px}
.footer{text-align:center;font-size:11px;color:#aaa;margin-top:16px}
</style></head><body><div class="wrap">${body}<div class="footer">מ.ס ארזים הנדסה בע"מ · המסמכים בקישור זה מיועדים לנמען בלבד</div></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

const errPage = (msg: string) =>
  page("חבילת מסמכים", `<div class="header"><h1>📦 חבילת מסמכים</h1></div><div class="body"><p>${H(msg)}</p></div>`);

Deno.serve(async (req) => {
  const token = new URL(req.url).searchParams.get("t") || "";
  if (!/^[a-f0-9]{24,64}$/.test(token)) return errPage("קישור לא תקין.");

  const shares = await rest(`pack_shares?token=eq.${token}&select=*`);
  const share = shares?.[0];
  if (!share) return errPage("קישור לא נמצא — ייתכן שבוטל. נא לפנות למשרד ארזים הנדסה.");
  if (new Date(share.expires_at) < new Date()) {
    return errPage("תוקף הקישור פג. נא לפנות למשרד ארזים הנדסה לקבלת קישור חדש.");
  }

  const table = share.kind === "i" ? "invoices" : "projects";
  const ents = await rest(`${table}?id=eq.${encodeURIComponent(share.ref_id)}&select=*`);
  const ent = ents?.[0];
  if (!ent) return errPage("המסמכים אינם זמינים. נא לפנות למשרד ארזים הנדסה.");

  let projName = "";
  if (share.kind === "i" && ent.project_id) {
    const ps = await rest(`projects?id=eq.${encodeURIComponent(ent.project_id)}&select=name,project_number`);
    if (ps?.[0]) projName = ps[0].name + (ps[0].project_number ? ` · ${ps[0].project_number}` : "");
  } else if (share.kind === "p") {
    projName = ent.name + (ent.project_number ? ` · ${ent.project_number}` : "");
  }
  const sub = share.kind === "i"
    ? `${ent.invoice_type || "מסמך"} ${ent.invoice_number || ""}${ent.amount ? " · " + Number(ent.amount).toLocaleString("he-IL") + " ₪" : ""}`
    : "פרויקט הממתין להזמנת עבודה";

  type Doc = { label: string; name: string; url: string };
  const docs: Doc[] = [];
  const slots: { label: string; req: boolean; docs: Doc[] }[] = [];
  const packSlots = ent.pack?.slots ?? [
    { k: "quote", label: "הצעת מחיר / חשבון עסקה", req: true, files: [] },
    { k: "acc", label: "חשבון קבלן חתום", req: true, files: [] },
    { k: "boq", label: "כתב כמויות חתום", req: false, files: [] },
    { k: "cinv", label: "חשבונית קבלן", req: true, files: [] },
  ];
  for (const s of packSlots) {
    const sd: Doc[] = [];
    if (s.k === "quote" && share.kind === "i" && ent.file_url && !(s.files?.length)) {
      const url = ent.file_url.startsWith("http") ? ent.file_url : await signPath(ent.file_url);
      if (url) sd.push({ label: s.label, name: "המסמך המקורי", url });
    }
    for (const f of s.files ?? []) {
      const url = await signPath(f.path);
      if (url) sd.push({ label: s.label, name: f.name, url });
    }
    slots.push({ label: s.label, req: !!s.req, docs: sd });
    docs.push(...sd);
  }

  const dateStr = new Date().toLocaleDateString("he-IL", { year: "numeric", month: "long", day: "numeric" });
  let b = `<div class="header"><h1>📦 חבילת מסמכים — ${H(projName || "ארזים הנדסה")}</h1><p>${H(sub)} · ${dateStr}</p></div><div class="body">`;
  b += `<p style="font-size:14px;line-height:1.6;margin:0 0 14px">להלן כל המסמכים הנדרשים להוצאת הזמנת עבודה / אישור החשבון. ניתן לפתוח כל מסמך בנפרד או להוריד את כולם כקובץ אחד להדפסה.</p>`;
  if (docs.length) {
    b += `<p style="margin:0 0 16px"><button class="btn" id="dl" onclick="mergeAll()">🖨️ הורד את כל המסמכים כ-PDF אחד (${docs.length})</button></p>`;
  }
  for (const s of slots) {
    if (!s.docs.length && !s.req) continue; // optional & empty — don't show noise
    b += `<div class="slot${s.docs.length ? " ok" : ""}"><h3>${s.docs.length ? "✅" : "⬜"} ${H(s.label)}</h3>`;
    if (s.docs.length) {
      for (const d of s.docs) b += `<div class="doc">📄 <a href="${H(d.url)}" target="_blank" rel="noopener">${H(d.name)}</a></div>`;
    } else b += `<div class="missing">טרם צורף — יושלם על ידי משרד ארזים הנדסה</div>`;
    b += `</div>`;
  }
  b += `<p class="note">הקישורים בדף מתחדשים בכל פתיחה. לשאלות: office@arazim-eng.co.il</p></div>`;
  b += `<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"><\/script><script>
var DOCS=${JSON.stringify(docs.map((d) => ({ n: d.name, u: d.url })))};
function imgPage(out,img){var pg=out.addPage([595,842]);var sc=Math.min(555/img.width,802/img.height,1);pg.drawImage(img,{x:(595-img.width*sc)/2,y:(842-img.height*sc)/2,width:img.width*sc,height:img.height*sc});}
function mergeAll(){
  var btn=document.getElementById('dl');btn.disabled=true;btn.textContent='⏳ מכין קובץ...';
  var skipped=0;
  PDFLib.PDFDocument.create().then(function(out){
    var chain=Promise.resolve();
    DOCS.forEach(function(d){
      chain=chain.then(function(){
        return fetch(d.u).then(function(r){return r.ok?r.arrayBuffer():null;}).catch(function(){return null;})
        .then(function(buf){
          if(!buf){skipped++;return;}
          var lo=d.u.toLowerCase().split('?')[0];
          if(/\\.png$/.test(lo))return out.embedPng(buf).then(function(im){imgPage(out,im);}).catch(function(){skipped++;});
          if(/\\.jpe?g$/.test(lo))return out.embedJpg(buf).then(function(im){imgPage(out,im);}).catch(function(){skipped++;});
          return PDFLib.PDFDocument.load(buf,{ignoreEncryption:true}).then(function(src){return out.copyPages(src,src.getPageIndices());}).then(function(pgs){pgs.forEach(function(p){out.addPage(p);});}).catch(function(){skipped++;});
        });
      });
    });
    return chain.then(function(){return out.save();});
  }).then(function(bytes){
    var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    a.download='חבילת מסמכים - ${H(projName).replace(/['\\\\]/g, "")}.pdf';document.body.appendChild(a);a.click();a.remove();
    btn.disabled=false;btn.textContent='🖨️ הורד את כל המסמכים כ-PDF אחד (${docs.length})';
    if(skipped)alert(skipped+' מסמכים לא צורפו לקובץ המאוחד — ניתן לפתוח אותם בנפרד מהרשימה');
  }).catch(function(e){btn.disabled=false;btn.textContent='🖨️ הורד את כל המסמכים כ-PDF אחד (${docs.length})';alert('שגיאה: '+e.message);});
}
<\/script>`;
  return page(`חבילת מסמכים — ${projName || "ארזים הנדסה"}`, b);
});
