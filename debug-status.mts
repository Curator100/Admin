import type { Config, Context } from "@netlify/functions";

/* =====================================================================
   Called by debug.html. Reports presence (not values) of every env var
   the notification system depends on, plus a live round-trip test of
   the Supabase service RPCs -- this is the single most likely thing to
   be missing/wrong on a first deploy (forgot to set an env var, secret
   didn't propagate to Functions scope, etc.), so the debug page can
   point straight at it instead of Roshid guessing.
   ===================================================================== */

async function testSupabaseRpc(url: string, key: string, secret: string) {
  try {
    const res = await fetch(`${url}/rest/v1/rpc/service_list_push_subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_secret: secret }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    }
    const data = await res.json();
    return { ok: true, detail: `Reachable. ${Array.isArray(data) ? data.length : 0} push subscription(s) on file.` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export default async (req: Request, context: Context) => {
  const vapidPublic = Netlify.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Netlify.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Netlify.env.get("VAPID_SUBJECT");
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const sweepSecret = Netlify.env.get("SWEEP_SECRET");

  const envVars = {
    VAPID_PUBLIC_KEY: !!vapidPublic,
    VAPID_PRIVATE_KEY: !!vapidPrivate,
    VAPID_SUBJECT: !!vapidSubject,
    SUPABASE_URL: !!supabaseUrl,
    SUPABASE_ANON_KEY: !!supabaseKey,
    SWEEP_SECRET: !!sweepSecret,
  };

  let supabaseTest = { ok: false, detail: "Skipped -- missing SUPABASE_URL, SUPABASE_ANON_KEY, or SWEEP_SECRET." };
  if (supabaseUrl && supabaseKey && sweepSecret) {
    supabaseTest = await testSupabaseRpc(supabaseUrl, supabaseKey, sweepSecret);
  }

  return new Response(
    JSON.stringify({
      envVars,
      allEnvVarsPresent: Object.values(envVars).every(Boolean),
      supabaseServiceRpcTest: supabaseTest,
      functionRegion: context.geo?.country?.name || null,
      checkedAt: new Date().toISOString(),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/debug-status",
};
