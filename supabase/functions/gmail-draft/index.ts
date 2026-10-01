// Creates a Gmail draft (never sends) for one of the member's contacts:
// To is the contact's saved email, the text comes from the app, and the
// job's resume PDF is attached from private storage.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const EMAIL_OK = /^[^\s@"()<>,;:]+@[^\s@"()<>,;:]+\.[a-z]{2,}$/i;

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
const utf8b64 = (s: string) => b64(new TextEncoder().encode(s));
const hdr = (s: string) => `=?UTF-8?B?${utf8b64(s.replace(/[\r\n]+/g, " "))}?=`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);
  let body: { person_id?: string; subject?: string; text?: string } = {};
  try { body = await req.json(); } catch (_) { /* empty */ }
  const subject = String(body.subject ?? "").slice(0, 200);
  const text = String(body.text ?? "").slice(0, 6000);
  if (!body.person_id || !subject || !text) return json({ error: "Missing message." }, 400);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: member } = await admin.from("members").select("email").ilike("email", user.email ?? "").maybeSingle();
  if (!member) return json({ error: "This account isn't on the list." }, 403);
  const { data: p } = await admin.from("people").select("id, company, email").eq("id", body.person_id).eq("user_id", user.id).maybeSingle();
  if (!p) return json({ error: "Contact not found." }, 404);
  const to = String(p.email ?? "").trim();
  if (!EMAIL_OK.test(to)) return json({ error: "Add a valid email for this contact first." }, 400);

  const { data: tok } = await admin.from("gmail_tokens").select("refresh_token, scopes").eq("user_id", user.id).maybeSingle();
  if (!tok) return json({ error: "Connect Gmail first.", needScope: true }, 409);
  if (!(tok.scopes ?? "").includes(COMPOSE)) return json({ error: "Allow drafts in Gmail first.", needScope: true }, 409);

  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: tok.refresh_token,
      grant_type: "refresh_token",
    }),
  }).then((r) => r.json());
  if (!tr.access_token) return json({ error: "Gmail needs to be reconnected.", needScope: true }, 409);
  if (tr.scope && !String(tr.scope).includes(COMPOSE)) {
    await admin.from("gmail_tokens").update({ scopes: tr.scope }).eq("user_id", user.id);
    return json({ error: "Allow drafts in Gmail first.", needScope: true }, 409);
  }

  // Resume for the job at this contact's company, if one is uploaded
  const { data: jobs } = await admin.from("jobs").select("company, resume").eq("active", true);
  const co = String(p.company ?? "").toLowerCase();
  const job = (jobs ?? []).find((j) => co && co.includes(String(j.company).toLowerCase()));
  let pdf: Uint8Array | null = null, fname = "";
  if (job?.resume) {
    const { data: file } = await admin.storage.from("resumes").download(`${job.resume}.pdf`);
    if (file) { pdf = new Uint8Array(await file.arrayBuffer()); fname = `${String(job.resume).replace(/\s*\(\d+\)$/, "")}.pdf`; /* drop a browser's " (4)" */ }
  }

  const boundary = "b_" + crypto.randomUUID().replaceAll("-", "");
  const parts = [
    `To: ${to}`,
    `Subject: ${hdr(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(utf8b64(text.replace(/\r?\n/g, "\r\n"))),
  ];
  if (pdf) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${fname}"`,
      `Content-Disposition: attachment; filename="${fname}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(b64(pdf)),
    );
  }
  parts.push(`--${boundary}--`, "");
  const raw = parts.join("\r\n");

  const dr = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media", {
    method: "POST",
    headers: { Authorization: `Bearer ${tr.access_token}`, "Content-Type": "message/rfc822" },
    body: raw,
  });
  const d = await dr.json();
  if (!dr.ok) {
    console.error("draft failed", d?.error?.message);
    if (dr.status === 403) return json({ error: "Allow drafts in Gmail first.", needScope: true }, 409);
    return json({ error: "Couldn't create the draft. Try again." }, 502);
  }
  if (d.message?.threadId) await admin.from("people").update({ thread_id: d.message.threadId }).eq("id", p.id);
  return json({
    ok: true,
    attached: !!pdf,
    url: `https://mail.google.com/mail/u/0/#drafts?compose=${d.message?.id ?? ""}`,
  });
});
