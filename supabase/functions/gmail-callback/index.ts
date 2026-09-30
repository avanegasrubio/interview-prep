// Google redirects here after the member approves read-only Gmail access.
// No Supabase JWT arrives on this redirect, so the request is authorized by the
// one-time state value that gmail-connect issued (single use, 15 minute expiry).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const APP = Deno.env.get("APP_URL") ?? "https://interview-prep-e.netlify.app";
const back = (q: string) => Response.redirect(`${APP}/?gmail=${q}`, 302);

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (u.searchParams.get("error") || !code || !state) return back("cancelled");

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: st } = await admin.from("gmail_oauth_state").select("user_id, created_at").eq("nonce", state).maybeSingle();
  await admin.from("gmail_oauth_state").delete().eq("nonce", state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back("expired");

  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      redirect_uri: `${url}/functions/v1/gmail-callback`,
      grant_type: "authorization_code",
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok || !tok.refresh_token) {
    console.error("token exchange failed", tok.error, tok.error_description);
    return back("error");
  }
  let address: string | null = null;
  try {
    const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());
    address = prof.emailAddress ?? null;
  } catch (_) { /* address is optional */ }

  const { error } = await admin.from("gmail_tokens").upsert({
    user_id: st.user_id,
    gmail_address: address,
    refresh_token: tok.refresh_token,
    connected_at: new Date().toISOString(),
  });
  if (error) { console.error(error); return back("error"); }
  return back("connected");
});
