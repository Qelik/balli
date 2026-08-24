/**
 * Screen Wake Lock. Arrived late in Safari and fails quietly when it fails, so
 * every call is defensive and the caller is told whether it actually held.
 */

type WakeLockSentinelLike = { released: boolean; release: () => Promise<void> };
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

let sentinel: WakeLockSentinelLike | null = null;
let wanted = false;

function api(): WakeLockLike | null {
  const nav = navigator as unknown as { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

export function wakeLockAvailable(): boolean {
  return api() !== null;
}

export async function acquireWakeLock(): Promise<boolean> {
  wanted = true;
  const wl = api();
  if (!wl) return false;
  try {
    sentinel = await wl.request("screen");
    return true;
  } catch {
    sentinel = null;
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  wanted = false;
  const current = sentinel;
  sentinel = null;
  if (!current || current.released) return;
  try {
    await current.release();
  } catch {
    /* ignore */
  }
}

// The lock is dropped whenever the page is hidden; re-take it on return or the
// screen dims mid-round after an incoming notification.
document.addEventListener("visibilitychange", () => {
  if (wanted && document.visibilityState === "visible" && !sentinel) {
    void acquireWakeLock();
  }
});
