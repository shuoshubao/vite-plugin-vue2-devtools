// events.js — records component events by patching Vue 2's `$emit`.
//
// We capture the Vue constructor from the global hook's `init` event (fired
// before the app mounts, since this module is imported early), then wrap
// `Vue.prototype.$emit` to log every custom event with its payload + source
// component. Lifecycle `hook:*` events are filtered out as noise.

import hook from './hook.js';

const events = [];
const listeners = new Set();
let patched = false;
let seq = 0;

const MaxEvents = 200;

const emit = () => {
    listeners.forEach(item => item());
};

const componentName = vm => {
    const options = (vm && vm.$options) || {};
    let name = options.name || options._componentTag;
    if (!name && options.__file) {
        name = String(options.__file)
            .split(/[\\/]/)
            .pop()
            .replace(/\.vue$/, '');
    }
    if (!name && vm && vm.$root === vm) {
        name = 'Root';
    }
    return name || 'Anonymous';
};

const record = (vm, name, args) => {
    if (typeof name === 'string' && name.indexOf('hook:') === 0) {
        return; // lifecycle noise
    }
    events.push({
        id: ++seq,
        name: String(name),
        args,
        component: componentName(vm),
        time: Date.now()
    });
    if (events.length > MaxEvents) {
        events.shift();
    }
    emit();
};

hook.on('init', Vue => {
    if (patched || !Vue || !Vue.prototype) {
        return;
    }
    patched = true;
    const original = Vue.prototype.$emit;
    // Must stay a real function: `this` is the emitting component instance.
    Vue.prototype.$emit = function (name, ...args) {
        try {
            record(this, name, args);
        } catch (err) {
            /* never break the app because of devtools */
        }
        return original.apply(this, arguments);
    };
});

export const getEvents = () => events;

export const subscribe = cb => {
    listeners.add(cb);
    return () => listeners.delete(cb);
};

export const clearEvents = () => {
    events.length = 0;
    emit();
};
