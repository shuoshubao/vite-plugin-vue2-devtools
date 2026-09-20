// main.js — injected entry. Importing ./hook.js first installs the global Vue
// devtools hook *before* the app imports Vue. Then we mount the inspector
// panel once the document is ready.

import './hook.js'
import './panel.js'

function mount() {
  if (document.querySelector('#__vue2_devtools__')) return
  const host = document.createElement('div')
  host.id = '__vue2_devtools__'
  document.body.appendChild(host)
  host.appendChild(document.createElement('vue2-devtools-panel'))
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount)
} else {
  mount()
}
