// panel.js — the floating inspector UI, a LitElement rendered inside a Shadow
// DOM overlay. It reads live Vue instances directly (same realm) and refreshes
// on every Vue scheduler flush.

import { LitElement, css, html } from 'lit'
import hook from './hook.js'
import { hide, highlight } from './inspector.js'
import { buildTree, getInstance, inspect, formatValue } from './walker.js'
import { isPicking, startPicking, stopPicking } from './picker.js'
import {
  hasStore,
  getSnapshots,
  getStore,
  subscribe as vuexSubscribe,
  travelTo,
  commitAll
} from './vuex.js'

export class Vue2DevtoolsPanel extends LitElement {
  static properties = {
    tree: { state: true },
    selectedId: { state: true },
    expanded: { state: true },
    highlightOn: { state: true },
    collapsed: { state: true },
    picking: { state: true },
    query: { state: true },
    tab: { state: true },
    vuexSelected: { state: true }
  }

  constructor() {
    super()
    this.tree = []
    this.selectedId = null
    this.expanded = new Set()
    this.highlightOn = true
    this.collapsed = false
    this.picking = false
    this.query = ''
    this.tab = 'components'
    this.vuexSelected = 0
    this._flushTimer = null
    this._scrollToSelected = false
    this._onFlush = () => this._scheduleRefresh()
    this._onKeydown = (e) => this._handleKeydown(e)
  }

  connectedCallback() {
    super.connectedCallback()
    hook.on('flush', this._onFlush)
    window.addEventListener('keydown', this._onKeydown, true)
    this._vuexUnsub = vuexSubscribe(() => this.requestUpdate())
    // First paint may happen before the app has mounted; retry shortly.
    this.refresh()
    setTimeout(() => this.refresh(), 300)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    hook.off('flush', this._onFlush)
    window.removeEventListener('keydown', this._onKeydown, true)
    if (this._vuexUnsub) this._vuexUnsub()
    stopPicking()
  }

  _scheduleRefresh() {
    clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => this.refresh(), 100)
  }

  refresh() {
    const tree = buildTree()
    this.tree = tree
    // Auto-expand roots the first time we see them.
    if (this.expanded.size === 0) {
      for (const root of tree) this.expanded.add(root.id)
    }
    // Keep highlight in sync with the currently selected instance.
    if (this.selectedId != null && this.highlightOn) {
      const vm = getInstance(this.selectedId)
      if (vm) highlight(vm)
    }
    this.requestUpdate()
  }

  _select(id) {
    this.selectedId = id
    const vm = getInstance(id)
    if (this.highlightOn && vm) highlight(vm)
  }

  _toggle(id) {
    if (this.expanded.has(id)) this.expanded.delete(id)
    else this.expanded.add(id)
    this.requestUpdate()
  }

  _toggleHighlight() {
    this.highlightOn = !this.highlightOn
    if (!this.highlightOn) hide()
    else if (this.selectedId != null) {
      const vm = getInstance(this.selectedId)
      if (vm) highlight(vm)
    }
  }

  _togglePick() {
    if (isPicking()) {
      stopPicking()
      this.picking = false
      return
    }
    this.picking = true
    startPicking((vm) => {
      this.picking = false
      this._selectVm(vm)
    })
  }

  // Select by live instance (used by the element picker): rebuild the tree,
  // expand the ancestor chain so the node is visible, then select + scroll.
  _selectVm(vm) {
    this.refresh()
    const path = this._pathToVm(vm)
    if (!path.length) return
    for (let i = 0; i < path.length - 1; i++) this.expanded.add(path[i])
    this._select(path[path.length - 1])
    this._scrollToSelected = true
    this.requestUpdate()
  }

  _pathToVm(vm) {
    let found = null
    const dfs = (node, trail) => {
      const next = [...trail, node.id]
      if (getInstance(node.id) === vm) {
        found = next
        return true
      }
      for (const c of node.children || []) if (dfs(c, next)) return true
      return false
    }
    for (const r of this.tree) if (dfs(r, [])) break
    return found || []
  }

  // Compute name-search filter. Returns null when no query is active.
  // Like vue-devtools: a matched component becomes a top-level entry with its
  // full descendant subtree shown; parent/ancestor components are hidden. A
  // match nested inside another match is not promoted (it shows in the subtree).
  _computeFilter() {
    const q = this.query.trim().toLowerCase()
    if (!q) return null
    const matched = new Set()
    const mark = (node) => {
      if (node.name.toLowerCase().includes(q)) matched.add(node.id)
      for (const c of node.children || []) mark(c)
    }
    for (const r of this.tree) mark(r)

    const roots = []
    const show = new Set()
    const collect = (node) => {
      show.add(node.id)
      for (const c of node.children || []) collect(c)
    }
    const walk = (node, hasMatchedAncestor) => {
      const isMatch = matched.has(node.id)
      if (isMatch && !hasMatchedAncestor) {
        roots.push(node)
        collect(node)
      }
      for (const c of node.children || []) walk(c, hasMatchedAncestor || isMatch)
    }
    for (const r of this.tree) walk(r, false)
    return { roots, show, q }
  }

  // Flatten the visible rows + parent links for keyboard navigation. During a
  // search the visible rows are the matched subtrees (all descendants shown).
  _index(filter) {
    const order = []
    const parent = new Map()
    const node = new Map()
    if (filter) {
      const walk = (n, p) => {
        node.set(n.id, n)
        parent.set(n.id, p)
        order.push(n.id)
        for (const c of n.children || []) {
          if (filter.show.has(c.id)) walk(c, n.id)
        }
      }
      for (const r of filter.roots) walk(r, null)
      return { order, parent, node }
    }
    const walk = (n, p) => {
      node.set(n.id, n)
      parent.set(n.id, p)
      order.push(n.id)
      if (n.children && n.children.length && this.expanded.has(n.id)) {
        for (const c of n.children) walk(c, n.id)
      }
    }
    for (const r of this.tree) walk(r, null)
    return { order, parent, node }
  }

  // Arrow-key navigation once a component is selected (VS Code / devtools style):
  // ↑/↓ move through visible rows, → step into / expand, ← step out / collapse.
  // During search the subtree is always shown, so →/← just navigate in/out.
  _handleKeydown(e) {
    if (this.collapsed || this.selectedId == null) return
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    // Don't hijack arrow keys while typing in a field. composedPath sees into
    // our shadow root (the search box) as well as the app's own inputs.
    const path = e.composedPath ? e.composedPath() : []
    const inEditable = path.some(
      (el) =>
        el &&
        el.tagName &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
    )
    if (inEditable) return

    const filter = this._computeFilter()
    const searching = !!filter
    const { order, parent, node } = this._index(filter)
    const id = this.selectedId
    const cur = node.get(id)
    if (!cur) return
    const i = order.indexOf(id)
    if (i < 0) return
    const shownChildren = (cur.children || []).filter(
      (c) => !filter || filter.show.has(c.id)
    )
    const hasChildren = shownChildren.length > 0
    const isOpen = searching ? true : this.expanded.has(id)
    let next = null

    if (e.key === 'ArrowDown') {
      next = order[Math.min(order.length - 1, i + 1)]
    } else if (e.key === 'ArrowUp') {
      next = order[Math.max(0, i - 1)]
    } else if (e.key === 'ArrowRight') {
      if (hasChildren && !isOpen) this.expanded.add(id)
      else if (hasChildren && isOpen) next = shownChildren[0].id
    } else if (e.key === 'ArrowLeft') {
      if (hasChildren && isOpen && !searching) this.expanded.delete(id)
      else next = parent.get(id)
    }

    e.preventDefault()
    if (next != null) this._select(next)
    this._scrollToSelected = true
    this.requestUpdate()
  }

  updated(changed) {
    // When the query changes, auto-select the first match (like vue-devtools).
    if (changed && changed.has('query') && this.query.trim()) {
      const f = this._computeFilter()
      if (f && f.roots.length && !f.show.has(this.selectedId)) {
        this._select(f.roots[0].id)
        this._scrollToSelected = true
      }
    }
    if (!this._scrollToSelected) return
    this._scrollToSelected = false
    const el = this.renderRoot.querySelector('.node.selected')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }

  _renderNode(node, depth) {
    const hasChildren = node.children && node.children.length > 0
    const isOpen = this.expanded.has(node.id)
    const isSelected = node.id === this.selectedId
    return html`
      <div>
        <div
          class="node ${isSelected ? 'selected' : ''}"
          style="padding-left:${depth * 12 + 4}px"
          @click=${() => this._select(node.id)}
        >
          <span
            class="arrow ${hasChildren ? '' : 'hidden'} ${isOpen ? 'open' : ''}"
            @click=${(e) => {
              e.stopPropagation()
              this._toggle(node.id)
            }}
            >▶</span
          >
          <span class="tag">&lt;${node.name}&gt;</span>
        </div>
        ${hasChildren && isOpen
          ? node.children.map((c) => this._renderNode(c, depth + 1))
          : null}
      </div>
    `
  }

  // Search result row: matched node as a subtree root, with all descendants
  // shown (always open). Ancestors are omitted. Arrow is non-interactive here.
  _renderSearchNode(node, depth, show) {
    const kids = (node.children || []).filter((c) => show.has(c.id))
    const isSelected = node.id === this.selectedId
    return html`
      <div>
        <div
          class="node ${isSelected ? 'selected' : ''}"
          style="padding-left:${depth * 12 + 4}px"
          @click=${() => this._select(node.id)}
        >
          <span class="arrow ${kids.length ? 'open' : 'hidden'}">▶</span>
          <span class="tag">&lt;${node.name}&gt;</span>
        </div>
        ${kids.map((c) => this._renderSearchNode(c, depth + 1, show))}
      </div>
    `
  }

  _renderSection(title, rows) {
    if (!rows.length) return null
    return html`
      <div class="section-title">${title}</div>
      ${rows.map(
        (r) => html`
          <div class="row">
            <span class="key">${r.key}</span>
            <span class="val">${r.value}</span>
          </div>
        `
      )}
    `
  }

  _renderDetail() {
    if (this.selectedId == null) {
      return html`<div class="empty">Select a component</div>`
    }
    const vm = getInstance(this.selectedId)
    if (!vm) return html`<div class="empty">Component unmounted</div>`
    const { props, data, computed } = inspect(vm)
    return html`
      ${this._renderSection('props', props)}
      ${this._renderSection('data', data)}
      ${this._renderSection('computed', computed)}
      ${!props.length && !data.length && !computed.length
        ? html`<div class="empty">No reactive state</div>`
        : null}
    `
  }

  render() {
    if (this.collapsed) {
      return html`<div class="fab" @click=${() => (this.collapsed = false)}>
        Vue2
      </div>`
    }
    const filter = this._computeFilter()
    const noMatch = filter && filter.roots.length === 0
    return html`
      <div class="panel">
        <div class="header">
          <span class="title">Vue 2 Devtools</span>
          <span class="spacer"></span>
          <button
            class="btn ${this.picking ? 'on' : ''}"
            title="Pick element on page (Esc to cancel)"
            @click=${() => this._togglePick()}
          >
            ⌖
          </button>
          <button
            class="btn ${this.highlightOn ? 'on' : ''}"
            title="Toggle highlight"
            @click=${() => this._toggleHighlight()}
          >
            ◈
          </button>
          <button class="btn" title="Refresh" @click=${() => this.refresh()}>
            ⟳
          </button>
          <button
            class="btn"
            title="Minimize"
            @click=${() => (this.collapsed = true)}
          >
            ─
          </button>
        </div>
        <div class="search">
          <input
            class="search-input"
            type="search"
            placeholder="Search components…"
            .value=${this.query}
            @input=${(e) => (this.query = e.target.value)}
            @keydown=${(e) => {
              if (e.key === 'Escape') {
                this.query = ''
                e.stopPropagation()
              }
            }}
          />
        </div>
        <div class="body">
          <div class="tree">
            ${!this.tree.length
              ? html`<div class="empty">No Vue app detected</div>`
              : noMatch
                ? html`<div class="empty">No component matches</div>`
                : filter
                  ? filter.roots.map((n) => this._renderSearchNode(n, 0, filter.show))
                  : this.tree.map((n) => this._renderNode(n, 0))}
          </div>
          <div class="detail">${this._renderDetail()}</div>
        </div>
      </div>
    `
  }

  static styles = css`
    :host {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      color: #e8e8e8;
    }
    .fab {
      background: #35495e;
      color: #41b883;
      font-weight: 700;
      padding: 8px 12px;
      border-radius: 20px;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
    }
    .panel {
      width: 520px;
      height: 380px;
      display: flex;
      flex-direction: column;
      background: #242424;
      border: 1px solid #3a3a3a;
      border-radius: 8px;
      box-shadow: 0 6px 30px rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      background: #35495e;
    }
    .title {
      color: #41b883;
      font-weight: 600;
    }
    .spacer {
      flex: 1;
    }
    .btn {
      background: transparent;
      border: 1px solid transparent;
      color: #cfd8dc;
      cursor: pointer;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 13px;
    }
    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .btn.on {
      color: #41b883;
      border-color: #41b883;
    }
    .body {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .search {
      padding: 5px 8px;
      background: #2b2b2b;
      border-bottom: 1px solid #3a3a3a;
    }
    .search-input {
      width: 100%;
      box-sizing: border-box;
      background: #1c1c1c;
      border: 1px solid #3a3a3a;
      border-radius: 4px;
      color: #e8e8e8;
      font-size: 12px;
      padding: 4px 8px;
      outline: none;
    }
    .search-input:focus {
      border-color: #41b883;
    }
    .tree {
      width: 45%;
      overflow: auto;
      border-right: 1px solid #3a3a3a;
      padding: 4px 0;
    }
    .detail {
      flex: 1;
      overflow: auto;
      padding: 6px 8px;
    }
    .node {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      white-space: nowrap;
      padding: 2px 4px;
      line-height: 18px;
    }
    .node:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .node.selected {
      background: #41b883;
      color: #17222b;
    }
    .arrow {
      display: inline-block;
      width: 10px;
      font-size: 8px;
      transition: transform 0.1s;
      color: #90a4ae;
    }
    .node.selected .arrow {
      color: #17222b;
    }
    .arrow.open {
      transform: rotate(90deg);
    }
    .arrow.hidden {
      visibility: hidden;
    }
    .tag {
      color: inherit;
    }
    .section-title {
      color: #ff8a65;
      font-weight: 600;
      margin: 8px 0 2px;
      text-transform: lowercase;
    }
    .row {
      display: flex;
      gap: 6px;
      padding: 1px 0;
    }
    .key {
      color: #80cbc4;
    }
    .val {
      color: #e8e8e8;
      word-break: break-all;
    }
    .empty {
      color: #789;
      padding: 8px;
      font-style: italic;
    }
  `
}

customElements.define('vue2-devtools-panel', Vue2DevtoolsPanel)
