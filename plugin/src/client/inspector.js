// inspector.js — a single reusable highlight box drawn over a component's DOM.

let box = null

function ensureBox() {
  if (box) return box
  box = document.createElement('div')
  Object.assign(box.style, {
    position: 'fixed',
    zIndex: '2147483646', // just under the panel
    background: 'rgba(65, 184, 131, 0.35)', // Vue green
    border: '1px solid rgba(65, 184, 131, 0.9)',
    borderRadius: '3px',
    pointerEvents: 'none',
    display: 'none',
    transition: 'all 0.08s ease-out'
  })
  document.body.appendChild(box)
  return box
}

export function highlight(vm) {
  const el = vm && vm.$el
  if (!el || !el.getBoundingClientRect) return hide()
  const rect = el.getBoundingClientRect()
  const b = ensureBox()
  Object.assign(b.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  })
}

export function hide() {
  if (box) box.style.display = 'none'
}
