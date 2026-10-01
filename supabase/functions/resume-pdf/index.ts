// Turns a queued resume (markdown) into a one-page PDF and saves it to the
// private "resumes" bucket as <name>.pdf, so the app's Download button and
// Gmail drafts can use it.
//
// It is called only by the database trigger on public.resume_queue (see
// supabase/migrations/resume_queue.sql). The request carries just the queue
// row id plus a shared secret header; the resume text is read from the table
// with the service role, never taken from the request.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { render } from "./render.ts";

const NAME_OK = /^Edwin-Allen_[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*_Resume$/;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const expected = Deno.env.get("RESUME_UPLOAD_TOKEN") ?? "";
  const got = req.headers.get("x-resume-token") ?? "";
  if (expected.length < 20 || !sameSecret(got, expected)) return json({ error: "Unauthorized" }, 401);

  let id = 0;
  try { id = Number((await req.json()).id); } catch (_) { /* empty */ }
  if (!Number.isInteger(id) || id <= 0) return json({ error: "Missing id" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await admin.from("resume_queue").select("id, name, markdown, status").eq("id", id).maybeSingle();
  if (!row) return json({ error: "Not found" }, 404);
  if (row.status !== "pending") return json({ ok: true, skipped: row.status });

  const finish = async (status: "done" | "error", error: string | null) =>
    await admin.from("resume_queue").update({ status, error, done_at: new Date().toISOString() }).eq("id", id);

  if (!NAME_OK.test(row.name) || row.name.length > 150) { await finish("error", "Bad file name"); return json({ error: "Bad file name" }, 400); }
  if (!row.markdown || row.markdown.length > 30000) { await finish("error", "Bad resume text"); return json({ error: "Bad resume text" }, 400); }

  let pdf: Uint8Array;
  try { pdf = await render(row.markdown); }
  catch (e) { const m = "Render failed: " + String(e).slice(0, 200); await finish("error", m); return json({ error: m }, 500); }

  // upsert false: never overwrite a PDF that is already uploaded (for example one Ari edited by hand)
  const { error } = await admin.storage.from("resumes").upload(`${row.name}.pdf`, pdf, { contentType: "application/pdf", upsert: false });
  if (error) {
    const m = /exist|duplicate/i.test(error.message) ? "A PDF with this name is already uploaded" : "Upload failed: " + error.message;
    await finish("error", m);
    return json({ error: m }, 409);
  }
  await finish("done", null);
  return json({ ok: true, file: `${row.name}.pdf` });
});
