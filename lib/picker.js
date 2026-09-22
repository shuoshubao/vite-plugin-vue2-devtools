// picker.js — "click an element on the page to select its component" mode.
// Hover draws a transient highlight + a name label; click resolves the nearest
// Vue instance and hands it back via the callback. Esc cancels.

let active = false;
let box = null;
let label = null;
let onPick = null;
let hovered = null;

const nearestVm = el => {
    while (el) {
        if (el.__vue__) {
            return el.__vue__;
        }
        el = el.parentElement;
    }
    return null;
};

const vmName = vm => {
    const options = vm.$options || {};
    let name = options.name || options._componentTag;
    if (!name && options.__file) {
        name = String(options.__file)
            .split(/[\\/]/)
            .pop()
            .replace(/\.vue$/, '');
    }
    if (!name && vm.$root === vm) {
        name = 'Root';
    }
    return name || 'Anonymous';
};

const ensureEls = () => {
    if (box) {
        return;
    }
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
};

const paint = vm => {
    const el = vm && vm.$el;
    if (!el || !el.getBoundingClientRect) {
        return clear();
    }
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
        display: 'block',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
    });
    label.textContent = `<${vmName(vm)}>`;
    label.style.display = 'block';
    label.style.top = `${Math.max(0, rect.top - 20)}px`;
    label.style.left = `${rect.left}px`;
};

const clear = () => {
    if (box) {
        box.style.display = 'none';
    }
    if (label) {
        label.style.display = 'none';
    }
};

const onMove = event => {
    const vm = nearestVm(event.target);
    hovered = vm;
    if (vm) {
        paint(vm);
    } else {
        clear();
    }
};

const onClick = event => {
    event.preventDefault();
    event.stopPropagation();
    const vm = hovered || nearestVm(event.target);
    const cb = onPick;
    stopPicking();
    if (vm && cb) {
        cb(vm);
    }
};

const onKey = event => {
    if (event.key === 'Escape') {
        stopPicking();
    }
};

export const startPicking = cb => {
    if (active) {
        return;
    }
    ensureEls();
    active = true;
    onPick = cb;
    hovered = null;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.body.style.cursor = 'crosshair';
};

export const stopPicking = () => {
    if (!active) {
        return;
    }
    active = false;
    onPick = null;
    hovered = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.style.cursor = '';
    clear();
};

export const isPicking = () => {
    return active;
};
