/* =====================================================================
   TOJ Admin -- Web Push client helper.
   Loaded by admin.html (silent auto-subscribe on login) and debug.html
   (manual controls + status checks). Depends on a global `sb` (Supabase
   client) and `currentAdmin` already being set by the page that loads
   this file.
   ===================================================================== */

const TOJ_VAPID_PUBLIC_KEY = window.TOJ_VAPID_PUBLIC_KEY || '';

function tojUrlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

const TojPush = {
  // Full diagnostic snapshot -- used by both the silent auto-subscribe
  // path and the Debug tool's checklist, so the two never disagree about
  // what "working" means.
  async getStatus() {
    const status = {
      serviceWorkerSupported: 'serviceWorker' in navigator,
      pushSupported: 'PushManager' in window,
      notificationPermission: (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported',
      vapidKeyPresent: !!TOJ_VAPID_PUBLIC_KEY,
      swRegistered: false,
      swActive: false,
      subscribed: false,
      subscriptionEndpoint: null,
      isSecureContext: window.isSecureContext,
      error: null
    };
    try {
      if (status.serviceWorkerSupported) {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        status.swRegistered = !!reg;
        status.swActive = !!(reg && reg.active);
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          status.subscribed = !!sub;
          status.subscriptionEndpoint = sub ? sub.endpoint : null;
        }
      }
    } catch (err) {
      status.error = err.message || String(err);
    }
    return status;
  },

  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers not supported in this browser.');
    return navigator.serviceWorker.register('/sw.js');
  },

  // Full subscribe flow: register SW, ask permission, create push
  // subscription, save it to Supabase against the logged-in admin.
  // Throws with a human-readable message at whichever step fails --
  // callers (debug tool) show that message directly.
  async subscribe(sb, currentAdmin) {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers.');
    if (!('PushManager' in window)) throw new Error('This browser does not support push notifications.');
    if (!window.isSecureContext) throw new Error('Push notifications require HTTPS (or localhost). This page is not in a secure context.');
    if (!TOJ_VAPID_PUBLIC_KEY) throw new Error('VAPID public key missing from the page -- check window.TOJ_VAPID_PUBLIC_KEY is set.');

    const reg = await this.registerServiceWorker();
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted (browser said: ' + permission + ').');

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: tojUrlBase64ToUint8Array(TOJ_VAPID_PUBLIC_KEY)
      });
    }

    const json = sub.toJSON();
    const { error } = await sb.rpc('admin_save_push_subscription', {
      p_admin_username: currentAdmin.username,
      p_admin_password_hash: currentAdmin.password_hash,
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: navigator.userAgent
    });
    if (error) throw new Error('Saved the subscription in the browser but failed to save it to the server: ' + error.message);

    return sub;
  },

  async unsubscribe(sb, currentAdmin) {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    if (sb && currentAdmin) {
      await sb.rpc('admin_remove_push_subscription', {
        p_admin_username: currentAdmin.username,
        p_admin_password_hash: currentAdmin.password_hash,
        p_endpoint: endpoint
      });
    }
  }
};

window.TojPush = TojPush;
