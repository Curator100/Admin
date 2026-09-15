import type { Config } from "@netlify/functions";
import webpush from "web-push";

/* =====================================================================
   Runs every minute (see netlify.toml). Claims unsent rows from
   tm_notification_queue via a service-secret RPC (no admin session
   exists in a scheduled function), sends each as a Web Push message to
   every registered admin device, and writes the delivery result back
   onto the notification row so the Notifications page and Debug tool
   can show whether it actually went out.
   ===================================================================== */

interface QueueRow {
  queue_id: number;
  notification_id: number;
  kind: string;
  title: string;
  body: string;
  ref_type: string | null;
  ref_id: string | null;
}

interface PushSubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

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
  const vapidPublic = Netlify.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Netlify.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Netlify.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

  if (!sweepSecret) {
    console.error("send-web-push: SWEEP_SECRET env var missing -- cannot authenticate to Supabase RPCs.");
    return;
  }
  if (!vapidPublic || !vapidPrivate) {
    console.error("send-web-push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars missing -- cannot send push.");
    return;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  let queueRows: QueueRow[] = [];
  let subs: PushSubRow[] = [];

  try {
    queueRows = (await supabaseRpc("service_claim_notification_queue", {
      p_secret: sweepSecret,
      p_limit: 50,
    })) || [];
  } catch (err) {
    console.error("send-web-push: failed to claim queue:", err);
    return;
  }

  if (queueRows.length === 0) {
    console.log("send-web-push: queue empty, nothing to send.");
    return;
  }

  try {
    subs = (await supabaseRpc("service_list_push_subscriptions", { p_secret: sweepSecret })) || [];
  } catch (err) {
    console.error("send-web-push: failed to list subscriptions:", err);
    // Still record the attempt against each notification so the debug
    // tool shows a clear "0 subs, fetch failed" instead of silence.
    for (const row of queueRows) {
      await supabaseRpc("service_record_push_result", {
        p_secret: sweepSecret,
        p_notification_id: row.notification_id,
        p_success_count: 0,
        p_failure_count: 0,
        p_error: "Failed to list push subscriptions: " + (err instanceof Error ? err.message : String(err)),
      }).catch(() => {});
    }
    return;
  }

  if (subs.length === 0) {
    console.warn("send-web-push: no push subscriptions registered -- notifications queued but nobody to send to.");
    for (const row of queueRows) {
      await supabaseRpc("service_record_push_result", {
        p_secret: sweepSecret,
        p_notification_id: row.notification_id,
        p_success_count: 0,
        p_failure_count: 0,
        p_error: "No admin devices are subscribed to push yet. Open the Debug tool and press Enable Notifications.",
      }).catch(() => {});
    }
    return;
  }

  for (const row of queueRows) {
    let successCount = 0;
    let failureCount = 0;
    let lastError: string | null = null;

    const payload = JSON.stringify({
      title: row.title,
      body: row.body,
      kind: row.kind,
      ref_type: row.ref_type,
      ref_id: row.ref_id,
      notification_id: row.notification_id,
      url: "/notifications.html?highlight=" + row.notification_id,
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        successCount++;
      } catch (err: any) {
        failureCount++;
        lastError = err && err.message ? err.message : String(err);
        // 404/410 means the browser/OS has permanently invalidated this
        // subscription (uninstalled, permission revoked, etc.) -- clean
        // it up so future sends don't keep failing against it.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await supabaseRpc("service_remove_push_subscription", {
            p_secret: sweepSecret,
            p_endpoint: sub.endpoint,
          }).catch(() => {});
        }
      }
    }

    await supabaseRpc("service_record_push_result", {
      p_secret: sweepSecret,
      p_notification_id: row.notification_id,
      p_success_count: successCount,
      p_failure_count: failureCount,
      p_error: lastError,
    }).catch((e) => console.error("send-web-push: failed to record result:", e));
  }
};

export const config: Config = {
  schedule: "* * * * *",
};
