// picker.js — "click an element on the page to select its component" mode.
// Hover draws a transient highlight + a name label; click resolves the nearest
// Vue instance and hands it back via the callback. Esc cancels.

let active = false;
let box = null;
let label = null;
let onPick = null;
let hovered = null;

function nearestVm(el) {
    while (el) {
        if (el.__vue__) return el.__vue__;
        el = el.parentElement;
    }
    return null;
}

function vmName(vm) {
    const o = vm.$options || {};
    let n = o.name || o._componentTag;
    if (!n && o.__file)
        n = String(o.__file)
            .split(/[\\/]/)
            .pop()
            .replace(/\.vue$/, '');
    if (!n && vm.$root === vm) n = 'Root';
    return n || 'Anonymous';
}

function ensureEls() {
    if (box) return;
    box = document.createElement('div');
    Object.assign(box.style, {
        position: 'fixed',
        zIndex: '2147483646',
        background: 'rgba(65, 184, 131, 0.35)',
        border: '1px solid rgba(65, 184, 131, 0.9)',
        borderRadius: '3px',
        pointerEvents: 'none',
        display: 'none'
    });
    label = document.createElement('div');
    Object.assign(label.style, {
        position: 'fixed',
        zIndex: '2147483647',
        background: '#41b883',
        color: '#17222b',
        font: '600 11px -apple-system, sans-serif',
        padding: '2px 6px',
        borderRadius: '3px',
        pointerEvents: 'none',
        display: 'none',
        whiteSpace: 'nowrap'
    });
    document.body.appendChild(box);
    document.body.appendChild(label);
}

function paint(vm) {
    const el = vm && vm.$el;
    if (!el || !el.getBoundingClientRect) return clear();
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
        display: 'block',
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`
    });
    label.textContent = `<${vmName(vm)}>`;
    label.style.display = 'block';
    label.style.top = `${Math.max(0, r.top - 20)}px`;
    label.style.left = `${r.left}px`;
}

function clear() {
    if (box) box.style.display = 'none';
    if (label) label.style.display = 'none';
}

function onMove(e) {
    const vm = nearestVm(e.target);
    hovered = vm;
    if (vm) paint(vm);
    else clear();
}

function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const vm = hovered || nearestVm(e.target);
    const cb = onPick;
    stopPicking();
    if (vm && cb) cb(vm);
}

function onKey(e) {
    if (e.key === 'Escape') stopPicking();
}

export function startPicking(cb) {
    if (active) return;
    ensureEls();
    active = true;
    onPick = cb;
    hovered = null;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.body.style.cursor = 'crosshair';
}

export function stopPicking() {
    if (!active) return;
    active = false;
    onPick = null;
    hovered = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.style.cursor = '';
    clear();
}

export function isPicking() {
    return active;
}
