/**
 * Screen Wake Lock. Arrived late in Safari and fails quietly when it fails, so
 * every call is defensive and the caller is told whether it actually held.
 */
let sentinel = null;
let wanted = false;
function api() {
    const nav = navigator;
    return nav.wakeLock ?? null;
}
export function wakeLockAvailable() {
    return api() !== null;
}
export async function acquireWakeLock() {
    wanted = true;
    const wl = api();
    if (!wl)
        return false;
    try {
        sentinel = await wl.request("screen");
        return true;
    }
    catch {
        sentinel = null;
        return false;
    }
}
export async function releaseWakeLock() {
    wanted = false;
    const current = sentinel;
    sentinel = null;
    if (!current || current.released)
        return;
    try {
        await current.release();
    }
    catch {
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
//# sourceMappingURL=wake.js.map