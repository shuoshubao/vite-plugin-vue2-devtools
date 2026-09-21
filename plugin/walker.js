// walker.js — turn live Vue 2 component instances into plain data the panel
// can render, and read a selected instance's props/data/computed.

// Stable ids across re-walks: same instance -> same id.
const idMap = new WeakMap();
let uid = 0;
const idOf = vm => {
    let id = idMap.get(vm);
    if (id === undefined) {
        id = ++uid;
        idMap.set(vm, id);
    }
    return id;
};

// Registry so the panel can resolve an id back to the live instance.
const registry = new Map();

export const getInstance = id => {
    return registry.get(id);
};

const displayName = vm => {
    const opts = vm.$options || {};
    let name = opts.name || opts._componentTag;
    if (!name && opts.__file) {
        // vite-plugin-vue2 sets __file in dev — gives nice names like "UserCard".
        name = String(opts.__file)
            .split(/[\\/]/)
            .pop()
            .replace(/\.vue$/, '');
    }
    if (!name && vm.$root === vm) name = 'Root';
    return name || 'Anonymous';
};

// Find every root instance currently mounted in the DOM. Vue 2 sets
// `el.__vue__` on component elements; `$root` dedupes them into app roots.
export const findRoots = () => {
    const roots = new Set();
    const els = document.querySelectorAll('*');
    for (const el of els) {
        const vm = el.__vue__;
        if (vm && vm.$root) roots.add(vm.$root);
    }
    return [...roots];
};

// Build a serialisable tree; keeps the registry in sync with what's shown.
// The synthetic root instance (`new Vue({ render: h => h(App) })`) carries no
// meaningful state, so — like vue-devtools — we skip it and surface its
// children (e.g. <App>) as the top-level nodes.
export const buildTree = () => {
    registry.clear();
    return findRoots().flatMap(vm => walk(vm).children);
};

const walk = vm => {
    const id = idOf(vm);
    registry.set(id, vm);
    return {
        id,
        name: displayName(vm),
        children: (vm.$children || []).map(walk)
    };
};

// ---- value formatting -------------------------------------------------------

// Render an arbitrary value into a short, safe display string. Same-realm, so
// we can inspect types directly; we just avoid dumping huge/circular objects.
export const formatValue = (value, depth = 0) => {
    const t = typeof value;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number' || t === 'boolean') return String(value);
    if (t === 'function') return `ƒ ${value.name || 'anonymous'}()`;
    if (t === 'symbol') return value.toString();
    if (value instanceof Node) return `<${value.nodeName.toLowerCase()}>`;
    if (Array.isArray(value)) {
        if (depth > 1) return `Array(${value.length})`;
        const items = value.slice(0, 5).map(v => formatValue(v, depth + 1));
        if (value.length > 5) items.push(`… +${value.length - 5}`);
        return `[${items.join(', ')}]`;
    }
    if (t === 'object') {
        if (depth > 1) return 'Object';
        const keys = Object.keys(value);
        const preview = keys.slice(0, 5).map(k => `${k}: ${formatValue(value[k], depth + 1)}`);
        if (keys.length > 5) preview.push('…');
        return `{ ${preview.join(', ')} }`;
    }
    return String(value);
};

// Extract props / data / computed for the detail pane. Values are returned raw
// (not stringified) so the panel can render an expandable value tree.
export const inspect = vm => {
    if (!vm) return { props: [], data: [], computed: [] };

    const props = [];
    const propDefs = (vm.$options && vm.$options.props) || null;
    if (propDefs) {
        for (const key of Object.keys(propDefs)) {
            props.push({ key, value: vm[key] });
        }
    }

    const data = [];
    const raw = vm._data || vm.$data;
    if (raw) {
        for (const key of Object.keys(raw)) {
            data.push({ key, value: raw[key] });
        }
    }

    const computed = [];
    const computedDefs = (vm.$options && vm.$options.computed) || null;
    if (computedDefs) {
        for (const key of Object.keys(computedDefs)) {
            let value;
            try {
                value = vm[key]; // reading the getter is intentional
            } catch (err) {
                value = `⚠ ${err && err.message}`;
            }
            computed.push({ key, value });
        }
    }

    return { props, data, computed };
};
