// hook.js — installs the Vue 2 global devtools hook.
//
// Vue 2.6 checks `window.__VUE_DEVTOOLS_GLOBAL_HOOK__` shortly after it loads
// (inside a setTimeout in vue.runtime.esm.js) and, when `config.devtools` is
// true (the default in dev builds), calls `hook.emit('init', Vue)`. After every
// patch the scheduler calls `hook.emit('flush')`. We implement a tiny emitter
// so we can capture the Vue constructor and subscribe to flushes for live
// refresh. This module MUST be imported before the app imports Vue.

const HOOK_KEY = '__VUE_DEVTOOLS_GLOBAL_HOOK__'

function createHook() {
  const listeners = Object.create(null)
  return {
    // captured Vue constructor (set on 'init')
    Vue: undefined,
    on(event, fn) {
      ;(listeners[event] || (listeners[event] = [])).push(fn)
    },
    off(event, fn) {
      const arr = listeners[event]
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i > -1) arr.splice(i, 1)
    },
    emit(event, ...args) {
      const arr = listeners[event]
      if (arr) arr.slice().forEach((fn) => fn(...args))
    }
  }
}

// Reuse an existing hook if one somehow already exists, otherwise install ours.
const hook = window[HOOK_KEY] || (window[HOOK_KEY] = createHook())

// Capture the Vue constructor as soon as Vue registers itself.
hook.on('init', (Vue) => {
  hook.Vue = Vue
})

export default hook
