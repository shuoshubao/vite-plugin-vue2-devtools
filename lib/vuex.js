// vuex.js — Vuex 3.x integration.
//
// Vuex's devtool plugin talks to the global hook: on store creation it emits
// `vuex:init` with the store, subscribes to mutations emitting `vuex:mutation`
// (mutation, state), and listens for `vuex:travel-to-state` to replaceState.
// We record a snapshot per mutation so the panel can inspect state over time
// and time-travel. This module must be imported before the store is created,
// which main.js guarantees (it runs before the app code).

import hook from './hook.js';

const snapshots = []; // { type, payload, state, base? }
const listeners = new Set();
let store = null;

const emit = () => {
    listeners.forEach(l => l());
};

// Deep clone so a snapshot isn't mutated by later state changes. Vuex state is
// normally serialisable; fall back to the live reference if it isn't.
const clone = state => {
    try {
        return JSON.parse(JSON.stringify(state));
    } catch (e) {
        return state;
    }
};

hook.on('vuex:init', s => {
    store = s;
    snapshots.length = 0;
    snapshots.push({
        type: 'Base State',
        payload: undefined,
        state: clone(s.state),
        base: true
    });
    emit();
});

hook.on('vuex:mutation', (mutation, state) => {
    if (!store) return;
    snapshots.push({
        type: mutation.type,
        payload: mutation.payload,
        state: clone(state),
        time: Date.now()
    });
    emit();
});

export const hasStore = () => {
    return !!store;
};

export const getSnapshots = () => {
    return snapshots;
};

export const getStore = () => {
    return store;
};

export const subscribe = cb => {
    listeners.add(cb);
    return () => listeners.delete(cb);
};

// Apply a recorded snapshot to the live store (Vuex's plugin does the
// replaceState in response to this event).
export const travelTo = index => {
    const snap = snapshots[index];
    if (!snap || !store) return;
    hook.emit('vuex:travel-to-state', snap.state);
};

// Drop history and treat the current live state as the new base.
export const commitAll = () => {
    if (!store) return;
    snapshots.length = 0;
    snapshots.push({
        type: 'Base State',
        payload: undefined,
        state: clone(store.state),
        base: true
    });
    emit();
};
