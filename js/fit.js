/**
 * Shrink text until it fits its box. Albanian and film titles run far longer
 * than the English one-worders the layout is designed around, and a card that
 * overflows is a card nobody can read from across the room.
 */
export function fitText(el, maxPx, minPx) {
    const parent = el.parentElement;
    if (!parent)
        return;
    const availableW = parent.clientWidth;
    const availableH = parent.clientHeight;
    if (availableW === 0 || availableH === 0)
        return;
    let lo = minPx;
    let hi = maxPx;
    let best = minPx;
    // 7 iterations resolves to ~1px over any sane range and stays well inside one frame.
    for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        el.style.fontSize = `${mid}px`;
        if (el.scrollWidth <= availableW && el.scrollHeight <= availableH) {
            best = mid;
            lo = mid;
        }
        else {
            hi = mid;
        }
    }
    el.style.fontSize = `${best}px`;
}
//# sourceMappingURL=fit.js.map