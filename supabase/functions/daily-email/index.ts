// Builds each member's morning email: the same "Today's list" the app shows
// (thank-you notes, applications due, outreach steps, follow-ups, practice).
// It sends nothing itself. A Google Apps Script in the admin's Gmail calls this
// each morning with the x-mail-secret header and sends what comes back, so the
// email arrives from a real Gmail address at no cost.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const APP = Deno.env.get("APP_URL") ?? "https://interview-prep-e.netlify.app";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const etDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const addDays = (iso: string, n: number) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const nice = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const esc = (t: unknown) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const VERB: Record<string, string> = { connect: "Send a LinkedIn request to", email: "Email your resume to", message: "Message", followup: "Follow up with" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function nextStep(p: any, today: string) {
  if (p.status === "Replied" || p.status === "Referral") return null;
  const steps: [string, number][] = [];
  if (p.url) steps.push(["connect", 0]);
  if (p.email) steps.push(["email", p.url ? 2 : 0]);
  if (p.url) steps.push(["message", 3]);
  steps.push(["followup", 5]);
  const seq = p.seq ?? {};
  let prev = p.created_at ? etDay(new Date(p.created_at)) : today;
  for (const [k, gap] of steps) {
    const due = addDays(prev, gap);
    const v = seq[k];
    if (!v) return { k, due };
    if (v !== "skip") prev = v;
  }
  return null;
}
const adviceFor = (j: any) => {
  const k = (j.kit ?? []).find((x: any) => /^Reach out first or apply first/i.test(x.label ?? ""));
  return k ? String(k.label).replace(/^Reach out first or apply first\??\s*/i, "").trim() : "";
};
function applyBy(j: any, today: string) {
  const a = adviceFor(j), added = j.added ?? today;
  const m = a.match(/apply by ([A-Za-z]{3})[a-z]*\.? (\d{1,2})/i);
  const mo = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (m && mo >= 0) {
    const y = +added.slice(0, 4), mk = (yy: number) => `${yy}-${String(mo + 1).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
    const k = mk(y); return k < added ? mk(y + 1) : k;
  }
  if (/apply (today|now|immediately|first)/i.test(a)) return added;
  return addDays(added, 2);
}

type Item = { rank: number; text: string; sub: string };
async function listFor(admin: any, userId: string, jobs: any[], today: string) {
  const [{ data: ppl }, { data: st }, { data: ev }, { data: pr }] = await Promise.all([
    admin.from("people").select("first, last, company, url, email, status, seq, source, created_at, messaged_at, followed_up").eq("user_id", userId),
    admin.from("job_status").select("job_id, status, applied_at, interview_at, followed_up, thanked_at").eq("user_id", userId),
    admin.from("events").select("type, at").eq("user_id", userId).eq("type", "applied").eq("at", today),
    admin.from("practice").select("days, remind").eq("user_id", userId).maybeSingle(),
  ]);
  const S: Record<string, any> = {};
  (st ?? []).forEach((r: any) => S[r.job_id] = r);
  const status = (id: string) => S[id]?.status ?? "To apply";
  const items: Item[] = [];
  const who = (p: any) => `${p.first} ${p.last ?? ""}`.trim() + (p.company ? ` at ${p.company}` : "");

  jobs.filter((j) => status(j.id) === "Interview" && S[j.id]?.interview_at && daysBetween(S[j.id].interview_at, today) <= 3 && !S[j.id]?.thanked_at)
    .forEach((j) => items.push({ rank: 0, text: `Send a thank-you note for ${j.company}`, sub: "Within 24 hours of the interview" }));
  const toApply = jobs.filter((j) => status(j.id) === "To apply").map((j) => ({ j, by: applyBy(j, today) }))
    .sort((a, b) => a.by.localeCompare(b.by) || (b.j.match ?? 0) - (a.j.match ?? 0));
  toApply.filter((x) => x.by <= today).forEach(({ j, by }) => {
    const late = daysBetween(by, today), adv = adviceFor(j);
    items.push({ rank: late > 0 ? 1 : 3, text: `Apply to ${j.company} · ${j.role}`, sub: (late > 0 ? `Was due ${nice(by)}` : "Due today") + (adv ? ` · ${adv}` : "") });
  });
  const onList = (p: any) => p.source === "Assigned" || Object.keys(p.seq ?? {}).length ||
    jobs.some((j) => p.company && String(p.company).toLowerCase().includes(String(j.company).toLowerCase()));
  // Outreach: at most 5 people a day. Overdue first, then anyone the job's advice names, then the soonest apply-by.
  const byCo = (co: string) => toApply.find((y) => co && co.toLowerCase().includes(String(y.j.company).toLowerCase())) ?? null;
  const out = (ppl ?? []).filter(onList).map((p: any) => ({ p, n: nextStep(p, today) })).filter((x: any) => x.n && x.n.due <= today)
    .map(({ p, n }: any) => {
      const x = byCo(p.company ?? ""), first = String(p.first ?? "").replace(/[^A-Za-z]/g, "");
      return { p, n, late: daysBetween(n.due, today), named: !!(x && first && new RegExp(`\\b${first}\\b`, "i").test(adviceFor(x.j))), by: x ? x.by : "9999" };
    })
    .sort((a: any, b: any) => (Number(b.late > 0) - Number(a.late > 0)) || (Number(b.named) - Number(a.named)) || a.by.localeCompare(b.by) || b.late - a.late);
  out.slice(0, 5).forEach(({ p, n, late, named }: any) => items.push({
    rank: late > 0 ? 2 : 3, text: `${VERB[n.k]} ${who(p)}`,
    sub: (late > 0 ? `Due ${late === 1 ? "yesterday" : late + " days ago"}` : "Due today") + (named ? " · Your best way in" : ""),
  }));
  if (out.length > 5) items.push({ rank: 3.5, text: `${out.length - 5} more people to contact`, sub: "After the five above. They'll move up as you go." });
  jobs.filter((j) => status(j.id) === "Applied" && S[j.id]?.applied_at && daysBetween(S[j.id].applied_at, today) >= 7 && !S[j.id]?.followed_up)
    .forEach((j) => items.push({ rank: 4, text: `Follow up on ${j.company}`, sub: `Applied ${daysBetween(S[j.id].applied_at, today)} days ago` }));
  (ppl ?? []).filter((p: any) => p.status === "Messaged" && !Object.keys(p.seq ?? {}).length && p.messaged_at && daysBetween(p.messaged_at, today) >= 5 && !p.followed_up)
    .forEach((p: any) => items.push({ rank: 4, text: `Follow up with ${who(p)}`, sub: `Messaged ${daysBetween(p.messaged_at, today)} days ago` }));
  if (!(ev ?? []).length && !items.some((x) => x.text.startsWith("Apply to"))) {
    const nx = [...toApply].sort((a, b) => (b.j.match ?? 0) - (a.j.match ?? 0))[0];
    if (nx) items.push({ rank: 5, text: `Get ahead: apply to ${nx.j.company} · ${nx.j.role}`, sub: `Apply by ${nice(nx.by)}` });
  }
  if (!((pr?.days ?? []) as string[]).includes(today)) items.push({ rank: 6, text: "Practice today's ticket, out loud", sub: "About 5 minutes" });
  items.sort((a, b) => a.rank - b.rank);
  return { items, emailOn: pr?.remind?.email !== false };
}

function render(name: string, items: Item[], today: string) {
  const link = `${APP}/?tab=today`;
  const n = items.length;
  const subject = n ? `Your list for ${nice(today)}: ${n} ${n === 1 ? "thing" : "things"}` : `Nothing due today, ${nice(today)}`;
  const text = [`Morning ${name},`, "",
    n ? "Here's today's list, most important first:" : "Nothing is due today. Nice.", "",
    ...items.map((x, i) => `${i + 1}. ${x.text}\n   ${x.sub}`), "",
    n ? "On a rough day, just do the first one." : "", `Open the app: ${link}`].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1830;max-width:520px;margin:0 auto;padding:8px">
<p style="font-size:16px;margin:0 0 12px">Morning ${esc(name)},</p>
<p style="font-size:16px;margin:0 0 16px">${n ? "Here's today's list, most important first:" : "Nothing is due today. Nice."}</p>
${items.map((x, i) => `<div style="border:1px solid #e7e2f7;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#ffffff">
<div style="font-size:15px;font-weight:600">${i + 1}. ${esc(x.text)}</div>
<div style="font-size:13px;color:${/^Was due|^Due (yesterday|\d)/.test(x.sub) ? "#a8480c" : "#615d7d"};margin-top:2px">${esc(x.sub)}</div></div>`).join("")}
${n ? `<p style="font-size:14px;color:#615d7d;margin:12px 0">On a rough day, just do the first one.</p>` : ""}
<p style="margin:16px 0"><a href="${link}" style="background:#8b77ff;color:#1a1830;text-decoration:none;font-weight:700;padding:11px 16px;border-radius:9px;display:inline-block">Open today's list</a></p>
<p style="font-size:12px;color:#615d7d">You can turn this email off on the Today tab of the app.</p></div>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await admin.rpc("check_mail_secret", { s: req.headers.get("x-mail-secret") ?? "" });
  if (!ok) return json({ error: "Not allowed." }, 401);
  let preview = false;
  try { preview = !!(await req.json()).preview; } catch (_) { /* empty body */ }
  const today = etDay();
  const { data: members } = await admin.from("members").select("email, role, display_name").neq("role", "admin");
  const { data: jobs } = await admin.from("jobs").select("id, company, role, added, kit, match").eq("active", true);
  const { data: ul } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const users = ul?.users ?? [];
  const emails: any[] = [];
  for (const m of members ?? []) {
    const u = (users ?? []).find((x: any) => String(x.email).toLowerCase() === String(m.email).toLowerCase());
    if (!u) continue;
    const { items, emailOn } = await listFor(admin, u.id, jobs ?? [], today);
    if (!emailOn && !preview) continue;
    emails.push({ to: m.email, ...render(m.display_name || "there", items, today) });
  }
  return json({ day: today, emails });
});
