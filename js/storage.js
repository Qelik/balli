/**
 * localStorage wrapper. Safari private mode throws on setItem, and a corrupted
 * value should never take the app down, so every path degrades to "no storage".
 */
export function read(key) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null)
            return null;
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* quota or private mode: play on without persistence */
    }
}
export function remove(key) {
    try {
        localStorage.removeItem(key);
    }
    catch {
        /* ignore */
    }
}
//# sourceMappingURL=storage.js.map