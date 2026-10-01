// Checks a member's Gmail for job emails, sorts them, matches them to jobs,
// and updates statuses and the scoreboard.
// Called two ways: by the signed-in member ("Check my email"), or by the daily
// schedule with a secret header, which checks every connected member.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const QUERY = [
  "newer_than:60d -in:sent -in:chats",
  "(from:(greenhouse.io OR greenhouse-mail.io OR lever.co OR hire.lever.co OR ashbyhq.com OR myworkday.com OR myworkdayjobs.com OR smartrecruiters.com OR icims.com OR jobvite.com OR workablemail.com OR bamboohr.com OR rippling.com OR jobs-noreply@linkedin.com)",
  'OR subject:(application OR applying OR applied OR interview OR "next steps" OR candidacy OR offer OR "your interest"))',
].join(" ");

// Checked in order; the first match wins. Strong interview wording is checked
// before "thanks for applying" so an invite that also thanks them counts as an
// interview, while a plain confirmation that mentions "next steps" stays "applied".
const RULES: [string, RegExp][] = [
  ["offer", /(offer letter|pleased to offer|extend(ing)? (you )?an offer|formal offer|job offer)/],
  ["rejected", /(unfortunately|not (be )?moving forward|decided (not )?to (move|pursue|proceed)[^.]{0,40}other|other candidates|no longer (being )?considered|not been selected|not selected|position has been filled|will not be proceeding|won't be moving)/],
  ["interview", /(schedule (a|an|some|your) (time|call|chat|interview)|your availability|times that work|book a time|calendly|goodtime\.io|phone screen|invite you to (an? )?(interview|call|chat)|like to (set up|arrange|schedule)|meet with the team)/],
  ["applied", /(thank(s| you) for (applying|your application|your interest)|application (was |has been )?(received|submitted|sent)|we('ve| have) received your application|your application was sent|successfully applied|confirming your application)/],
  ["interview", /\binterview\b/],
];
const NOREPLY = /(no-?reply|donotreply|notifications?|jobs-noreply|talent@|careers@|recruiting@|hr@)/i;
const RANK: Record<string, number> = { "To apply": 0, "Applied": 1, "Replied": 2, "Interview": 3, "Offer": 4 };

async function accessToken(refresh: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!r.ok) return { error: j.error ?? "token_error" };
  return { token: j.access_token as string, scope: (j.scope as string) ?? null };
}

const header = (m: any, name: string) =>
  (m.payload?.headers ?? []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function decode(s: string) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function companyGuess(sender: string) {
  const name = sender.replace(/<.*>/, "").replace(/"/g, "").trim();
  const cleaned = name.replace(/\b(recruiting|talent|careers|hiring|team|jobs|via .*|at )\b/gi, "").replace(/[|\-–]+$/, "").trim();
  if (cleaned && !/no-?reply|linkedin|workday|greenhouse|lever|ashby/i.test(cleaned)) return cleaned.slice(0, 60);
  const dom = (sender.match(/@([^>\s]+)/) ?? [])[1] ?? "";
  return dom.split(".").slice(-2, -1)[0] ?? null;
}

// Matches the member's own emails to contacts that have an email address:
// a sent email checks off the "email" step (a second one checks off the follow-up),
// and any email from the contact marks them Replied and stops the sequence.
const EMAIL_OK = /^[^\s@"()<>,;:]+@[^\s@"()<>,;:]+\.[a-z]{2,}$/i;
async function listDates(H: Record<string, string>, q: string, max: number): Promise<string[]> {
  const l = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`,
    { headers: H },
  ).then((r) => r.json());
  const out: string[] = [];
  for (const m of l.messages ?? []) {
    const d = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=minimal`, { headers: H }).then((r) => r.json());
    if (d.internalDate) out.push(new Date(Number(d.internalDate)).toISOString().slice(0, 10));
  }
  return out.sort();
}
async function trackContacts(admin: SupabaseClient, userId: string, H: Record<string, string>) {
  const { data: ppl } = await admin.from("people")
    .select("id, first, last, email, status, seq, messaged_at, replied_at, followed_up")
    .eq("user_id", userId).not("email", "is", null).neq("email", "")
    .not("status", "in", "(Replied,Referral)").limit(40);
  let changed = 0;
  for (const p of ppl ?? []) {
    const addr = String(p.email).trim().toLowerCase();
    if (!EMAIL_OK.test(addr)) continue;
    const sent = await listDates(H, `in:sent to:${addr} newer_than:120d`, 3);
    const got = await listDates(H, `from:${addr} -in:sent newer_than:120d`, 1);
    const seq = { ...(p.seq ?? {}) };
    const upd: Record<string, unknown> = {};
    if (sent[0] && !seq.email) { seq.email = sent[0]; upd.seq = seq; }
    if (sent[1] && seq.email && seq.email !== "skip" && !seq.followup) { seq.followup = sent[1]; upd.seq = seq; upd.followed_up = sent[1]; }
    if (sent[0] && p.status === "To message") { upd.status = "Messaged"; upd.messaged_at = p.messaged_at ?? sent[0]; }
    if (got[0]) { upd.status = "Replied"; upd.replied_at = p.replied_at ?? got[0]; }
    if (!Object.keys(upd).length) continue;
    await admin.from("people").update(upd).eq("id", p.id).eq("user_id", userId);
    if (got[0] && p.status !== "Replied") {
      await admin.from("events").insert({ user_id: userId, type: "reply", label: `${p.first} ${p.last ?? ""} (email)`.replace(/ +/g, " "), at: got[0] });
    }
    changed++;
  }
  return changed;
}

async function syncUser(admin: SupabaseClient, row: any, jobs: any[]) {
  const at = await accessToken(row.refresh_token);
  if (!at.token) {
    if (at.error === "invalid_grant") await admin.from("gmail_tokens").delete().eq("user_id", row.user_id);
    return { reconnect: true, found: 0, added: 0, updated: 0 };
  }
  const H = { Authorization: `Bearer ${at.token}` };
  if (at.scope) await admin.from("gmail_tokens").update({ scopes: at.scope }).eq("user_id", row.user_id);
  const contacts = await trackContacts(admin, row.user_id, H).catch((e) => { console.error(e); return 0; });
  const list = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=60&q=${encodeURIComponent(QUERY)}`,
    { headers: H },
  ).then((r) => r.json());
  const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
  if (!ids.length) {
    await admin.from("gmail_tokens").update({ last_sync_at: new Date().toISOString() }).eq("user_id", row.user_id);
    return { reconnect: false, found: 0, added: 0, updated: 0, contacts };
  }
  const { data: seen } = await admin.from("email_updates").select("message_id").eq("user_id", row.user_id).in("message_id", ids);
  const seenSet = new Set((seen ?? []).map((s: any) => s.message_id));
  const fresh = ids.filter((id) => !seenSet.has(id));

  const { data: statuses } = await admin.from("job_status").select("*").eq("user_id", row.user_id);
  const stById: Record<string, any> = {};
  (statuses ?? []).forEach((s: any) => (stById[s.job_id] = s));

  let added = 0, updated = 0;
  const msgs = [];
  for (const id of fresh) {
    const m = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: H },
    ).then((r) => r.json());
    if (m.id) msgs.push(m);
  }
  // oldest first, so statuses move forward in order
  msgs.sort((a, b) => Number(a.internalDate) - Number(b.internalDate));

  for (const m of msgs) {
    const sender = header(m, "From");
    const subject = header(m, "Subject");
    const snippet = decode(m.snippet ?? "");
    const text = `${subject} ${snippet}`.toLowerCase();
    let kind = "other";
    for (const [k, re] of RULES) if (re.test(text)) { kind = k; break; }
    const hay = `${sender} ${subject} ${snippet}`.toLowerCase();
    const job = jobs.find((j) => hay.includes(j.company.toLowerCase()));
    if (kind === "other" && job && !NOREPLY.test(sender)) kind = "reply";
    if (kind === "other") continue; // skip job alerts, newsletters and anything unclear
    const received = new Date(Number(m.internalDate));
    const day = received.toISOString().slice(0, 10);
    const guess = job ? job.company : companyGuess(sender);

    const { error } = await admin.from("email_updates").insert({
      user_id: row.user_id, message_id: m.id, received_at: received.toISOString(),
      sender: sender.slice(0, 300), subject: subject.slice(0, 300), snippet: snippet.slice(0, 500),
      kind, job_id: job?.id ?? null, company_guess: guess,
    });
    if (error) continue;
    added++;

    const label = guess ?? "Email";
    if (job) {
      const cur = stById[job.id] ?? { status: "To apply" };
      if (cur.status === "Passed") continue;
      const next: any = { user_id: row.user_id, job_id: job.id, status: cur.status, updated_at: new Date().toISOString() };
      let changed = false;
      if (kind === "rejected") { if (cur.status !== "Rejected") { next.status = "Rejected"; changed = true; } }
      else {
        const target = kind === "applied" ? "Applied" : kind === "reply" ? "Replied" : kind === "interview" ? "Interview" : "Offer";
        if ((RANK[target] ?? 0) > (RANK[cur.status] ?? 0)) { next.status = target; changed = true; }
      }
      if (!changed) continue;
      if (kind === "applied" && !cur.applied_at) next.applied_at = day;
      if (kind === "reply" && !cur.reply_at) next.reply_at = day;
      if (kind === "interview" && !cur.interview_at) next.interview_at = day;
      if (kind === "offer" && !cur.offer_at) next.offer_at = day;
      await admin.from("job_status").upsert({ ...cur, ...next });
      stById[job.id] = { ...cur, ...next };
      await admin.from("events").insert({ user_id: row.user_id, type: kind, label: `${label} (email)`, at: day });
      updated++;
    } else {
      // A company not on the list: still counts on the scoreboard
      await admin.from("events").insert({ user_id: row.user_id, type: kind, label: `${label} (email)`, at: day });
    }
  }
  await admin.from("gmail_tokens").update({ last_sync_at: new Date().toISOString() }).eq("user_id", row.user_id);
  return { reconnect: false, found: fresh.length, added, updated, contacts };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!Deno.env.get("GOOGLE_CLIENT_ID")) return json({ error: "Gmail isn't set up yet." }, 503);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let userIds: string[] | null = null;
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await admin.rpc("check_cron_secret", { s: cronSecret });
    if (!ok) return json({ error: "Not allowed." }, 401);
  } else {
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sign in first." }, 401);
    userIds = [user.id];
  }

  let q = admin.from("gmail_tokens").select("*");
  if (userIds) q = q.in("user_id", userIds);
  const { data: rows } = await q;
  if (!rows?.length) return json({ connected: false });
  const { data: jobs } = await admin.from("jobs").select("id, company").eq("active", true);

  const results = [];
  for (const row of rows) {
    try { results.push({ user_id: row.user_id, ...(await syncUser(admin, row, jobs ?? [])) }); }
    catch (e) { console.error(e); results.push({ user_id: row.user_id, error: true }); }
  }
  return json(userIds ? { connected: true, ...results[0] } : { results });
});
