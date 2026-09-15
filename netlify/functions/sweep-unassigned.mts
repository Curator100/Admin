import type { Config } from "@netlify/functions";

/* =====================================================================
   Runs every 10 minutes (see netlify.toml). Calls the
   service_run_unassigned_sweep RPC, which does all the actual logic in
   Postgres (find tuitions unassigned 5h+, enqueue a reminder, repeat
   every 5h) -- this function is just the clock that triggers it.
   ===================================================================== */

async function supabaseRpc(fn: string, body: Record<string, unknown>) {
  const url = Netlify.env.get("SUPABASE_URL");
  const key = Netlify.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_ANON_KEY env var missing");

  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC ${fn} failed: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export default async (req: Request) => {
  const sweepSecret = Netlify.env.get("SWEEP_SECRET");
  if (!sweepSecret) {
    console.error("sweep-unassigned: SWEEP_SECRET env var missing -- cannot authenticate to Supabase.");
    return;
  }

  try {
    const fired = await supabaseRpc("service_run_unassigned_sweep", { p_secret: sweepSecret });
    console.log(`sweep-unassigned: fired ${fired} reminder notification(s).`);
  } catch (err) {
    console.error("sweep-unassigned: sweep failed:", err);
  }
};

export const config: Config = {
  schedule: "*/10 * * * *",
};
