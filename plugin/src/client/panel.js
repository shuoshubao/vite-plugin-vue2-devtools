// panel.js — the floating inspector UI, a LitElement rendered inside a Shadow
// DOM overlay. It reads live Vue instances directly (same realm) and refreshes
// on every Vue scheduler flush.

import { LitElement, css, html } from 'lit'
import hook from './hook.js'
import { hide, highlight } from './inspector.js'
import { buildTree, getInstance, inspect } from './walker.js'

export class Vue2DevtoolsPanel extends LitElement {
  static properties = {
    tree: { state: true },
    selectedId: { state: true },
    expanded: { state: true },
    highlightOn: { state: true },
    collapsed: { state: true }
  }

  constructor() {
    super()
    this.tree = []
    this.selectedId = null
    this.expanded = new Set()
    this.highlightOn = true
    this.collapsed = false
    this._flushTimer = null
    this._onFlush = () => this._scheduleRefresh()
  }

  connectedCallback() {
    super.connectedCallback()
    hook.on('flush', this._onFlush)
    // First paint may happen before the app has mounted; retry shortly.
    this.refresh()
    setTimeout(() => this.refresh(), 300)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    hook.off('flush', this._onFlush)
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
    return html`
      <div class="panel">
        <div class="header">
          <span class="title">Vue 2 Devtools</span>
          <span class="spacer"></span>
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
        <div class="body">
          <div class="tree">
            ${this.tree.length
              ? this.tree.map((n) => this._renderNode(n, 0))
              : html`<div class="empty">No Vue app detected</div>`}
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
