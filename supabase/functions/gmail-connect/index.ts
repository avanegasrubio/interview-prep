// Starts the Gmail connection: returns Google's consent URL for the signed-in member.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  if (!clientId || !Deno.env.get("GOOGLE_CLIENT_SECRET")) {
    return json({ error: "Gmail isn't set up yet. The Google keys still need to be added in Supabase." }, 503);
  }
  const url = Deno.env.get("SUPABASE_URL")!;
  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Sign in first." }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: member } = await admin.from("members").select("email").ilike("email", user.email ?? "").maybeSingle();
  if (!member) return json({ error: "This account isn't on the list." }, 403);

  const nonce = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  await admin.from("gmail_oauth_state").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
  const { error } = await admin.from("gmail_oauth_state").insert({ nonce, user_id: user.id });
  if (error) return json({ error: "Couldn't start the connection. Try again." }, 500);

  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${url}/functions/v1/gmail-callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: nonce,
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` });
});
