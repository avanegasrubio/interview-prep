// Sends each member one morning notification with what's due today:
// outreach steps, follow-ups, thank-you notes and the practice ticket.
// Called by the daily schedule (x-cron-secret) or by a signed-in member with {test:true}.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { send } from "./webpush.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const etDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const VERB: Record<string, string> = { connect: "Send a LinkedIn request to", email: "Email your resume to", message: "Message", followup: "Follow up with" };

function nextStep(p: any) {
  if (p.status === "Replied" || p.status === "Referral") return null;
  const steps: [string, number][] = [];
  if (p.url) steps.push(["connect", 0]);
  if (p.email) steps.push(["email", p.url ? 2 : 0]);
  if (p.url) steps.push(["message", 3]);
  steps.push(["followup", 5]);
  const seq = p.seq ?? {};
  let prev = p.created_at ? etDay(new Date(p.created_at)) : etDay();
  for (const [k, gap] of steps) {
    const due = addDays(prev, gap);
    const v = seq[k];
    if (!v) return { k, due };
    if (v !== "skip") prev = v;
  }
  return null;
}

async function summary(admin: SupabaseClient, userId: string, jobs: any[]) {
  const today = etDay();
  const [{ data: ppl }, { data: st }] = await Promise.all([
    admin.from("people").select("first, last, company, url, email, status, seq, source, created_at").eq("user_id", userId),
    admin.from("job_status").select("job_id, status, applied_at, interview_at, followed_up, thanked_at").eq("user_id", userId),
  ]);
  const onList = (p: any) => p.source === "Assigned" || Object.keys(p.seq ?? {}).length ||
    jobs.some((j) => p.company && String(p.company).toLowerCase().includes(String(j.company).toLowerCase()));
  const due = (ppl ?? []).filter(onList).map((p) => ({ p, n: nextStep(p) })).filter((x) => x.n && x.n.due <= today)
    .sort((a, b) => a.n!.due.localeCompare(b.n!.due));
  const company = (id: string) => jobs.find((j) => j.id === id)?.company ?? "a company";
  const fu = (st ?? []).filter((s) => s.status === "Applied" && s.applied_at && s.applied_at <= addDays(today, -7) && !s.followed_up);
  const thanks = (st ?? []).filter((s) => s.status === "Interview" && s.interview_at && s.interview_at >= addDays(today, -3) && !s.thanked_at);
  const parts: string[] = [];
  if (thanks.length) parts.push(`Send a thank-you note to ${company(thanks[0].job_id)}`);
  if (due.length) {
    const f = due[0];
    parts.push(`${VERB[f.n!.k]} ${f.p.first}${f.p.company ? " at " + f.p.company : ""}${due.length > 1 ? ` (+${due.length - 1} more)` : ""}`);
  }
  if (fu.length) parts.push(`Follow up on ${company(fu[0].job_id)}${fu.length > 1 ? ` and ${fu.length - 1} more` : ""}`);
  parts.push("Practice one ticket out loud");
  const title = due.length || fu.length || thanks.length ? "Today's job search" : "15 minutes today";
  // Number for the home-screen icon badge: items due today plus the practice ticket
  const count = thanks.length + due.length + fu.length + 1;
  return { title, body: parts.join(" · "), url: "/?tab=today", tag: "daily-" + today, count };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let only: string | null = null, test = false;
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    const { data: ok } = await admin.rpc("check_cron_secret", { s: cron });
    if (!ok) return json({ error: "Not allowed." }, 401);
  } else {
    const uc = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "Sign in first." }, 401);
    only = user.id; test = true;
  }
  const { data: keys } = await admin.rpc("get_vapid");
  const k = keys?.[0];
  if (!k?.pub || !k?.priv) return json({ error: "Push keys missing." }, 500);
  let q = admin.from("push_subscriptions").select("*");
  if (only) q = q.eq("user_id", only);
  const { data: subs } = await q;
  if (!subs?.length) return json({ sent: 0 });
  const { data: jobs } = await admin.from("jobs").select("id, company").eq("active", true);
  const byUser: Record<string, any[]> = {};
  subs.forEach((s) => (byUser[s.user_id] ??= []).push(s));
  let sent = 0;
  for (const [uid, list] of Object.entries(byUser)) {
    const msg = await summary(admin, uid, jobs ?? []);
    if (test) { msg.title = "Notifications are on"; msg.tag = "test"; }
    for (const s of list) {
      try {
        const status = await send(s, msg, k.pub, k.priv);
        if (status === 404 || status === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        else if (status < 300) sent++;
        else console.error("push status", status);
      } catch (e) { console.error(e); }
    }
  }
  return json({ sent });
});
