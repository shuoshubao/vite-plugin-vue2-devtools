// panel.js — the floating inspector UI, a LitElement rendered inside a Shadow
// DOM overlay. It reads live Vue instances directly (same realm) and refreshes
// on every Vue scheduler flush.

import { LitElement, css, html } from 'lit';
import hook from './hook.js';
import { hide, highlight } from './inspector.js';
import { isPicking, startPicking, stopPicking } from './picker.js';
import { commitAll, getSnapshots, getStore, hasStore, travelTo, subscribe as vuexSubscribe } from './vuex.js';
import { buildTree, formatValue, getInstance } from './walker.js';

export class Vue2DevtoolsPanel extends LitElement {
    static properties = {
        tree: { state: true },
        selectedId: { state: true },
        expanded: { state: true },
        collapsed: { state: true },
        picking: { state: true },
        query: { state: true },
        tab: { state: true },
        vuexSelected: { state: true }
    };

    constructor() {
        super();
        this.tree = [];
        this.selectedId = null;
        this.expanded = new Set();
        this.collapsed = false;
        this.picking = false;
        this.query = '';
        this.tab = 'components';
        this.vuexSelected = 0;
        this.valueExpanded = new Set();
        this.sectionCollapsed = new Set();
        this._editingPath = null;
        this._focusEdit = false;
        this._flushTimer = null;
        this._scrollToSelected = false;
        this._onFlush = () => this._scheduleRefresh();
        this._onKeydown = e => this._handleKeydown(e);
    }

    connectedCallback() {
        super.connectedCallback();
        hook.on('flush', this._onFlush);
        window.addEventListener('keydown', this._onKeydown, true);
        this._vuexUnsub = vuexSubscribe(() => this.requestUpdate());
        // First paint may happen before the app has mounted; retry shortly.
        this.refresh();
        setTimeout(() => this.refresh(), 300);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        hook.off('flush', this._onFlush);
        window.removeEventListener('keydown', this._onKeydown, true);
        if (this._vuexUnsub) this._vuexUnsub();
        stopPicking();
    }

    _scheduleRefresh() {
        clearTimeout(this._flushTimer);
        this._flushTimer = setTimeout(() => this.refresh(), 100);
    }

    refresh() {
        const tree = buildTree();
        this.tree = tree;
        // Auto-expand roots the first time we see them.
        if (this.expanded.size === 0) {
            for (const root of tree) this.expanded.add(root.id);
        }
        this.requestUpdate();
    }

    _select(id) {
        this.selectedId = id;
    }

    _toggle(id) {
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        this.requestUpdate();
    }

    // Highlight the page DOM only while hovering a tree row (vue-devtools style).
    _hoverEnter(id) {
        const vm = getInstance(id);
        if (vm) highlight(vm);
    }

    _hoverLeave() {
        hide();
    }

    _togglePick() {
        if (isPicking()) {
            stopPicking();
            this.picking = false;
            return;
        }
        this.picking = true;
        startPicking(vm => {
            this.picking = false;
            this._selectVm(vm);
        });
    }

    // Select by live instance (used by the element picker): rebuild the tree,
    // expand the ancestor chain so the node is visible, then select + scroll.
    _selectVm(vm) {
        this.refresh();
        const path = this._pathToVm(vm);
        if (!path.length) return;
        for (let i = 0; i < path.length - 1; i++) this.expanded.add(path[i]);
        this._select(path[path.length - 1]);
        this._scrollToSelected = true;
        this.requestUpdate();
    }

    _pathToVm(vm) {
        let found = null;
        const dfs = (node, trail) => {
            const next = [...trail, node.id];
            if (getInstance(node.id) === vm) {
                found = next;
                return true;
            }
            for (const c of node.children || []) if (dfs(c, next)) return true;
            return false;
        };
        for (const r of this.tree) if (dfs(r, [])) break;
        return found || [];
    }

    // Compute name-search filter. Returns null when no query is active.
    // Like vue-devtools: a matched component becomes a top-level entry with its
    // full descendant subtree shown; parent/ancestor components are hidden. A
    // match nested inside another match is not promoted (it shows in the subtree).
    _computeFilter() {
        const q = this.query.trim().toLowerCase();
        if (!q) return null;
        const matched = new Set();
        const mark = node => {
            if (node.name.toLowerCase().includes(q)) matched.add(node.id);
            for (const c of node.children || []) mark(c);
        };
        for (const r of this.tree) mark(r);

        const roots = [];
        const show = new Set();
        const collect = node => {
            show.add(node.id);
            for (const c of node.children || []) collect(c);
        };
        const walk = (node, hasMatchedAncestor) => {
            const isMatch = matched.has(node.id);
            if (isMatch && !hasMatchedAncestor) {
                roots.push(node);
                collect(node);
            }
            for (const c of node.children || []) walk(c, hasMatchedAncestor || isMatch);
        };
        for (const r of this.tree) walk(r, false);
        return { roots, show, q };
    }

    // Flatten the visible rows + parent links for keyboard navigation. During a
    // search the visible rows are the matched subtrees (all descendants shown).
    _index(filter) {
        const order = [];
        const parent = new Map();
        const node = new Map();
        if (filter) {
            const walk = (n, p) => {
                node.set(n.id, n);
                parent.set(n.id, p);
                order.push(n.id);
                for (const c of n.children || []) {
                    if (filter.show.has(c.id)) walk(c, n.id);
                }
            };
            for (const r of filter.roots) walk(r, null);
            return { order, parent, node };
        }
        const walk = (n, p) => {
            node.set(n.id, n);
            parent.set(n.id, p);
            order.push(n.id);
            if (n.children && n.children.length && this.expanded.has(n.id)) {
                for (const c of n.children) walk(c, n.id);
            }
        };
        for (const r of this.tree) walk(r, null);
        return { order, parent, node };
    }

    // Arrow-key navigation once a component is selected (VS Code / devtools style):
    // ↑/↓ move through visible rows, → step into / expand, ← step out / collapse.
    // During search the subtree is always shown, so →/← just navigate in/out.
    _handleKeydown(e) {
        if (this.collapsed || this.selectedId == null) return;
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        // Don't hijack arrow keys while typing in a field. composedPath sees into
        // our shadow root (the search box) as well as the app's own inputs.
        const path = e.composedPath ? e.composedPath() : [];
        const inEditable = path.some(el => el && el.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable));
        if (inEditable) return;

        const filter = this._computeFilter();
        const searching = !!filter;
        const { order, parent, node } = this._index(filter);
        const id = this.selectedId;
        const cur = node.get(id);
        if (!cur) return;
        const i = order.indexOf(id);
        if (i < 0) return;
        const shownChildren = (cur.children || []).filter(c => !filter || filter.show.has(c.id));
        const hasChildren = shownChildren.length > 0;
        // A node is "open" if its children are currently shown. In search mode the
        // matched subtree is always shown.
        const isOpen = searching || this.expanded.has(id);
        let next = null;

        if (e.key === 'ArrowDown') {
            next = order[Math.min(order.length - 1, i + 1)];
        } else if (e.key === 'ArrowUp') {
            next = order[Math.max(0, i - 1)];
        } else if (e.key === 'ArrowRight') {
            // Closed with children -> open it; already open -> step into first child.
            if (hasChildren && !isOpen) this.expanded.add(id);
            else if (hasChildren && isOpen) next = shownChildren[0].id;
        } else if (e.key === 'ArrowLeft') {
            // Check open/closed FIRST: open -> collapse; closed (or leaf) -> parent.
            if (isOpen && hasChildren && !searching) this.expanded.delete(id);
            else next = parent.get(id);
        }

        e.preventDefault();
        if (next != null) this._select(next);
        this._scrollToSelected = true;
        this.requestUpdate();
    }

    updated(changed) {
        // Focus a freshly opened inline editor.
        if (this._focusEdit) {
            this._focusEdit = false;
            const input = this.renderRoot.querySelector('.edit-input');
            if (input) {
                input.focus();
                input.select();
            }
        }
        // When the query changes, auto-select the first match (like vue-devtools).
        if (changed && changed.has('query') && this.query.trim()) {
            const f = this._computeFilter();
            if (f && f.roots.length && !f.show.has(this.selectedId)) {
                this._select(f.roots[0].id);
                this._scrollToSelected = true;
            }
        }
        if (!this._scrollToSelected) return;
        this._scrollToSelected = false;
        const el = this.renderRoot.querySelector('.node.selected');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    _renderNode(node, depth) {
        const hasChildren = node.children && node.children.length > 0;
        const isOpen = this.expanded.has(node.id);
        const isSelected = node.id === this.selectedId;
        return html`
            <div>
                <div
                    class="node ${isSelected ? 'selected' : ''}"
                    style="padding-left:${depth * 12 + 4}px"
                    @click=${() => this._select(node.id)}
                    @mouseenter=${() => this._hoverEnter(node.id)}
                    @mouseleave=${() => this._hoverLeave()}
                >
                    <span
                        class="caret-btn"
                        @click=${e => {
                            e.stopPropagation();
                            this._toggle(node.id);
                        }}
                    >
                        ${this._caret(isOpen, !hasChildren)}
                    </span>
                    <span class="tag">&lt;${node.name}&gt;</span>
                </div>
                ${hasChildren && isOpen ? node.children.map(c => this._renderNode(c, depth + 1)) : null}
            </div>
        `;
    }

    // Search result row: matched node as a subtree root, with all descendants
    // shown (always open). Ancestors are omitted. Arrow is non-interactive here.
    _renderSearchNode(node, depth, show) {
        const kids = (node.children || []).filter(c => show.has(c.id));
        const isSelected = node.id === this.selectedId;
        return html`
            <div>
                <div
                    class="node ${isSelected ? 'selected' : ''}"
                    style="padding-left:${depth * 12 + 4}px"
                    @click=${() => this._select(node.id)}
                    @mouseenter=${() => this._hoverEnter(node.id)}
                    @mouseleave=${() => this._hoverLeave()}
                >
                    <span class="caret-btn static">${this._caret(kids.length > 0, kids.length === 0)}</span>
                    <span class="tag">&lt;${node.name}&gt;</span>
                </div>
                ${kids.map(c => this._renderSearchNode(c, depth + 1, show))}
            </div>
        `;
    }

    // Render an object as a titled, collapsible section of expandable value rows.
    // `editable` enables inline editing of primitive leaves (writes back into obj).
    _renderKvSection(title, obj, editable) {
        const keys = obj ? Object.keys(obj) : [];
        if (!keys.length) return null;
        const collapsed = this.sectionCollapsed.has(title);
        return html`
            <div class="section-title" @click=${() => this._toggleSection(title)}>${this._caret(!collapsed, false)} ${title}</div>
            ${collapsed ? null : keys.map(k => this._renderValueRow(k, obj[k], `${title}.${k}`, 0, obj, editable))}
        `;
    }

    _toggleSection(title) {
        if (this.sectionCollapsed.has(title)) this.sectionCollapsed.delete(title);
        else this.sectionCollapsed.add(title);
        this.requestUpdate();
    }

    _toggleValue(path) {
        if (this.valueExpanded.has(path)) this.valueExpanded.delete(path);
        else this.valueExpanded.add(path);
        this.requestUpdate();
    }

    // Recursive, expandable value viewer. Objects/arrays expand in place; when
    // `editable` is set, primitive leaves can be clicked to edit in place.
    _renderValueRow(keyLabel, value, path, depth, parent, editable) {
        const isObj = value !== null && typeof value === 'object';
        const keys = isObj ? (Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value)) : [];
        const expandable = isObj && keys.length > 0;
        const open = this.valueExpanded.has(path);
        const canEdit = editable && !isObj && typeof value !== 'function';
        const editing = this._editingPath === path;
        return html`
            <div class="vrow ${expandable ? 'expandable' : ''}" style="padding-left:${depth * 12 + 2}px" @click=${() => expandable && this._toggleValue(path)}>
                <span class="caret-btn static">${this._caret(open, !expandable)}</span>
                <span class="key">${keyLabel}</span>
                <span class="colon">:</span>
                ${editing
                    ? html`
                          <input
                              class="edit-input"
                              .value=${String(value)}
                              @click=${e => e.stopPropagation()}
                              @keydown=${e => this._onEditKeydown(e, parent, keyLabel, value)}
                              @blur=${e => this._commitEdit(parent, keyLabel, e.target.value, value)}
                          />
                      `
                    : html`
                          <span
                              class="val ${this._valClass(value)} ${canEdit ? 'editable' : ''}"
                              @click=${e => {
                                  if (!canEdit) return;
                                  e.stopPropagation();
                                  this._editingPath = path;
                                  this._focusEdit = true;
                                  this.requestUpdate();
                              }}
                          >
                              ${this._preview(value, keys)}
                          </span>
                      `}
                ${!editing
                    ? html`
                          <button
                              class="copy-btn"
                              title="Copy value"
                              @click=${e => {
                                  e.stopPropagation();
                                  this._copyValue(value);
                              }}
                          >
                              ⧉
                          </button>
                      `
                    : null}
            </div>
            ${expandable && open ? keys.map(k => this._renderValueRow(k, value[k], `${path}.${k}`, depth + 1, value, editable)) : null}
        `;
    }

    _copyValue(value) {
        let text;
        if (value !== null && typeof value === 'object') {
            try {
                text = JSON.stringify(value, null, 2);
            } catch (e) {
                text = String(value);
            }
        } else {
            text = typeof value === 'string' ? value : String(value);
        }
        this._writeClipboard(text);
    }

    // navigator.clipboard only exists in secure contexts (https / localhost), so
    // over plain http (e.g. http://localhost:5000) fall back to execCommand.
    _writeClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).catch(() => this._fallbackCopy(text));
        } else {
            this._fallbackCopy(text);
        }
    }

    _fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
            document.execCommand('copy');
        } catch (e) {
            /* ignore */
        }
        document.body.removeChild(ta);
    }

    _onEditKeydown(e, parent, key, oldValue) {
        e.stopPropagation();
        if (e.key === 'Enter') {
            this._commitEdit(parent, key, e.target.value, oldValue);
        } else if (e.key === 'Escape') {
            this._editingPath = null;
            this.requestUpdate();
        }
    }

    // Parse the input back to the original primitive type and write it into the
    // reactive parent object (Vue.set keeps arrays / new keys reactive).
    _commitEdit(parent, key, rawStr, oldValue) {
        this._editingPath = null;
        let parsed = rawStr;
        const t = typeof oldValue;
        if (t === 'number') {
            const n = Number(rawStr);
            parsed = Number.isNaN(n) ? oldValue : n;
        } else if (t === 'boolean') {
            parsed = rawStr === 'true' || rawStr === '1';
        } else if (oldValue === null || oldValue === undefined) {
            try {
                parsed = JSON.parse(rawStr);
            } catch (e) {
                parsed = rawStr;
            }
        }
        const Vue = hook.Vue;
        if (parent) {
            if (Vue && Vue.set) Vue.set(parent, key, parsed);
            else parent[key] = parsed;
        }
        this.requestUpdate();
    }

    _valClass(value) {
        if (value === null || value === undefined) return 'v-null';
        const t = typeof value;
        if (t === 'number') return 'v-num';
        if (t === 'boolean') return 'v-bool';
        if (t === 'string') return 'v-str';
        if (t === 'function') return 'v-fn';
        return 'v-obj';
    }

    // Short preview: expandable objects/arrays show a type/size summary; leaves
    // reuse the walker's formatter.
    _preview(value, keys) {
        if (value !== null && typeof value === 'object') {
            return Array.isArray(value) ? `Array[${value.length}]` : `Object{${keys.length}}`;
        }
        return formatValue(value);
    }

    _renderDetail() {
        if (this.selectedId == null) {
            return html`
                <div class="empty">Select a component</div>
            `;
        }
        const vm = getInstance(this.selectedId);
        if (!vm)
            return html`
                <div class="empty">Component unmounted</div>
            `;

        const propsObj = vm._props || {};
        const dataObj = vm._data || vm.$data || {};
        const compDefs = (vm.$options && vm.$options.computed) || {};
        const compObj = {};
        for (const k of Object.keys(compDefs)) {
            try {
                compObj[k] = vm[k];
            } catch (err) {
                compObj[k] = `⚠ ${err && err.message}`;
            }
        }
        const attrsObj = vm.$attrs || {};
        const has = Object.keys(propsObj).length || Object.keys(dataObj).length || Object.keys(compObj).length || Object.keys(attrsObj).length;
        return html`
            ${this._renderKvSection('props', propsObj, true)} ${this._renderKvSection('data', dataObj, true)}
            ${this._renderKvSection('computed', compObj, false)} ${this._renderKvSection('attrs', attrsObj, false)}
            ${!has
                ? html`
                      <div class="empty">No reactive state</div>
                  `
                : null}
        `;
    }

    render() {
        if (this.collapsed) {
            return html`
                <div class="fab" @click=${() => (this.collapsed = false)}>DevTools</div>
            `;
        }
        return html`
            <div class="panel">
                <nav class="sidebar">
                    <div class="logo">${this._vueLogo()}</div>
                    <button class="side-tab ${this.tab === 'components' ? 'active' : ''}" title="Components" @click=${() => (this.tab = 'components')}>
                        ${this._icon('components')}
                    </button>
                    <button class="side-tab ${this.tab === 'vuex' ? 'active' : ''}" title="Vuex" @click=${() => (this.tab = 'vuex')}>
                        ${this._icon('vuex')}
                    </button>
                    <span class="side-spacer"></span>
                    ${this.tab === 'components'
                        ? html`
                              <button
                                  class="side-tab ${this.picking ? 'active' : ''}"
                                  title="Pick element on page (Esc to cancel)"
                                  @click=${() => this._togglePick()}
                              >
                                  ${this._icon('pick')}
                              </button>
                          `
                        : null}
                    <button class="side-tab" title="Minimize" @click=${() => (this.collapsed = true)}>${this._icon('min')}</button>
                </nav>
                <div class="main">${this.tab === 'components' ? this._renderComponents() : this._renderVuex()}</div>
            </div>
        `;
    }

    _renderComponents() {
        const filter = this._computeFilter();
        const noMatch = filter && filter.roots.length === 0;
        return html`
            <div class="search">
                <input
                    class="search-input"
                    type="search"
                    placeholder="Search components…"
                    .value=${this.query}
                    @input=${e => (this.query = e.target.value)}
                    @keydown=${e => {
                        if (e.key === 'Escape') {
                            this.query = '';
                            e.stopPropagation();
                        }
                    }}
                />
            </div>
            <div class="body">
                <div class="tree">
                    ${!this.tree.length
                        ? html`
                              <div class="empty">No Vue app detected</div>
                          `
                        : noMatch
                        ? html`
                              <div class="empty">No component matches</div>
                          `
                        : filter
                        ? filter.roots.map(n => this._renderSearchNode(n, 0, filter.show))
                        : this.tree.map(n => this._renderNode(n, 0))}
                </div>
                <div class="detail">${this._renderDetail()}</div>
            </div>
        `;
    }

    _renderVuex() {
        if (!hasStore()) {
            return html`
                <div class="body">
                    <div class="empty">No Vuex store detected</div>
                </div>
            `;
        }
        const snaps = getSnapshots();
        const sel = Math.min(this.vuexSelected, snaps.length - 1);
        const snap = snaps[sel];
        return html`
            <div class="body">
                <div class="tree">
                    <div class="vuex-bar">
                        <button
                            class="btn"
                            title="Commit all — clear history, keep current state"
                            @click=${() => {
                                commitAll();
                                this.vuexSelected = 0;
                            }}
                        >
                            ✓ Commit All
                        </button>
                    </div>
                    ${snaps.map(
                        (s, i) => html`
                            <div class="node ${i === sel ? 'selected' : ''}" @click=${() => (this.vuexSelected = i)}>
                                <span class="mut-index">${s.base ? '' : i}</span>
                                <span class="tag">${s.base ? 'Base State' : s.type}</span>
                            </div>
                        `
                    )}
                </div>
                <div class="detail">${snap ? this._renderVuexDetail(snap, sel) : null}</div>
            </div>
        `;
    }

    _renderVuexDetail(snap, index) {
        const store = getStore();
        const payloadObj = snap.payload === undefined ? null : { payload: snap.payload };
        return html`
            ${!snap.base
                ? html`
                      <button class="btn on time-travel" @click=${() => travelTo(index)}>⏱ Time Travel</button>
                  `
                : null}
            ${this._renderKvSection('mutation', { type: snap.type }, false)} ${payloadObj ? this._renderKvSection('payload', payloadObj, false) : null}
            ${this._renderKvSection('state', snap.state || {}, false)} ${store ? this._renderKvSection('getters (live)', store.getters || {}, false) : null}
        `;
    }

    // Official Vue logo (three triangles).
    _vueLogo() {
        return html`
            <svg viewBox="0 0 256 221" aria-hidden="true">
                <path d="M204.8 0H256L128 220.8 0 0h97.92L128 51.2 157.44 0z" fill="#41b883" />
                <path d="M0 0l128 220.8L256 0h-51.2L128 132.48 50.56 0z" fill="#41b883" />
                <path d="M50.56 0L128 133.12 204.8 0h-47.36L128 51.2 97.92 0z" fill="#35495e" />
            </svg>
        `;
    }

    // Inline stroked icons (currentColor) for the sidebar / toolbar.
    _icon(name) {
        switch (name) {
            case 'components':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="3" width="6" height="5" rx="1" />
                        <rect x="3" y="16" width="6" height="5" rx="1" />
                        <rect x="15" y="16" width="6" height="5" rx="1" />
                        <path d="M12 8v3M6 16v-2h12v2" />
                    </svg>
                `;
            case 'vuex':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <ellipse cx="12" cy="5" rx="8" ry="3" />
                        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
                        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
                    </svg>
                `;
            case 'pick':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                        <circle cx="12" cy="12" r="4" />
                    </svg>
                `;
            case 'min':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M5 12h14" />
                    </svg>
                `;
            default:
                return null;
        }
    }

    // Expand/collapse caret as an SVG chevron — rotates cleanly around center
    // (unlike a text glyph, which drifts when rotated).
    _caret(open, hidden) {
        return html`
            <svg class="caret ${open ? 'open' : ''} ${hidden ? 'hidden' : ''}" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        `;
    }

    static styles = css`
        :host {
            --accent: #41b883;
            --accent-600: #2f9e6d;
            --bg: #ffffff;
            --surface: #f7f8fa;
            --border: #edeff2;
            --border-strong: #e4e7ec;
            --field-border: #d0d5dd;
            --text: #1f2937;
            --text-strong: #101828;
            --muted: #98a2b3;
            --muted-2: #667085;
            --radius: 12px;
            --radius-sm: 7px;
            --c-key: #7c3aed;
            --c-num: #1d4ed8;
            --c-bool: #9333ea;
            --c-str: #16a34a;
            --c-null: #b45309;
            --c-fn: #2563eb;
            --c-obj: #475467;

            position: fixed;
            inset-block-end: 12px;
            inset-inline-end: 12px;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            font-size: 12px;
            color: var(--text);
        }
        .fab {
            padding-block: 9px;
            padding-inline: 14px;
            border-radius: 999px;
            font-weight: 700;
            color: #fff;
            cursor: pointer;
            background: linear-gradient(135deg, var(--accent), var(--accent-600));
            box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 35%, transparent);
        }
        .panel {
            inline-size: 620px;
            block-size: 420px;
            display: grid;
            grid-template-columns: 48px 1fr;
            overflow: hidden;
            background: var(--bg);
            border: 1px solid var(--border-strong);
            border-radius: var(--radius);
            box-shadow: 0 12px 40px rgb(16 24 40 / 0.18);
        }
        .sidebar {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding-block: 8px;
            background: var(--surface);
            border-inline-end: 1px solid var(--border);
        }
        .logo {
            inline-size: 24px;
            block-size: 24px;
            margin-block-end: 6px;

            & svg {
                inline-size: 100%;
                block-size: 100%;
                display: block;
            }
        }
        .side-tab {
            display: grid;
            place-items: center;
            inline-size: 34px;
            block-size: 34px;
            border: 0;
            border-radius: 9px;
            color: var(--muted-2);
            background: transparent;
            cursor: pointer;
            transition:
                color 0.15s,
                background 0.15s;

            & svg {
                inline-size: 20px;
                block-size: 20px;
            }
            &:hover {
                color: var(--text);
                background: color-mix(in srgb, var(--text) 8%, transparent);
            }
            &.active {
                color: var(--accent);
                background: color-mix(in srgb, var(--accent) 14%, transparent);
            }
        }
        .side-spacer {
            flex: 1;
        }
        .main {
            display: flex;
            flex-direction: column;
            min-inline-size: 0;
            min-block-size: 0;
            overflow: hidden;
        }
        .btn {
            display: inline-flex;
            padding: 4px 8px;
            border: 0;
            border-radius: var(--radius-sm);
            font-size: 13px;
            color: var(--muted-2);
            background: transparent;
            cursor: pointer;
            transition:
                background 0.15s,
                color 0.15s;

            & svg {
                inline-size: 16px;
                block-size: 16px;
                display: block;
            }
            &:hover {
                color: var(--text);
                background: color-mix(in srgb, var(--text) 8%, transparent);
            }
            &.on {
                color: #fff;
                background: var(--accent);
            }
        }
        .body {
            flex: 1;
            min-block-size: 0;
            display: grid;
            grid-template-columns: 45% 1fr;
        }
        .search {
            padding: 5px 8px;
            background: var(--surface);
            border-block-end: 1px solid var(--border);

            & .search-input {
                inline-size: 100%;
                box-sizing: border-box;
                padding: 4px 8px;
                color: var(--text-strong);
                background: var(--bg);
                border: 1px solid var(--field-border);
                border-radius: 4px;
                font-size: 12px;
                outline: none;

                &:focus {
                    border-color: var(--accent);
                }
            }
        }
        .tree {
            overflow: auto;
            padding-block: 4px;
            border-inline-end: 1px solid var(--border);
        }
        .detail {
            overflow: auto;
            padding: 6px 8px;
        }
        .node {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 4px;
            line-height: 18px;
            white-space: nowrap;
            cursor: pointer;

            &:hover {
                background: color-mix(in srgb, var(--text) 6%, transparent);
            }
            &.selected {
                color: #fff;
                background: var(--accent);

                & :is(.caret, .mut-index) {
                    color: #fff;
                }
            }
        }
        .caret-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            inline-size: 12px;
            block-size: 17px;
            flex: none;
        }
        .caret-btn.static {
            pointer-events: none;
        }
        .caret {
            inline-size: 9px;
            block-size: 9px;
            color: var(--muted);
            transform-origin: 50% 50%;
            transition: transform 0.12s ease;

            &.open {
                transform: rotate(90deg);
            }
            &.hidden {
                visibility: hidden;
            }
        }
        .tag {
            color: inherit;
        }
        .section-title {
            display: flex;
            align-items: center;
            gap: 3px;
            margin-block: 8px 2px;
            font-weight: 500;
            color: var(--muted);
            text-transform: lowercase;
            cursor: pointer;

            &:hover {
                color: #475467;
            }
        }
        .vrow {
            display: flex;
            align-items: baseline;
            gap: 3px;
            padding-block: 1px;
            line-height: 17px;
            white-space: nowrap;

            &.expandable {
                cursor: pointer;
            }
            &:hover .copy-btn {
                visibility: visible;
            }
        }
        .key {
            color: var(--c-key);
        }
        .colon {
            color: var(--muted);
        }
        .val {
            word-break: break-all;
            white-space: normal;

            &.editable {
                cursor: text;
                border-radius: 2px;

                &:hover {
                    background: color-mix(in srgb, var(--accent) 15%, transparent);
                    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent);
                }
            }
        }
        .edit-input {
            min-inline-size: 60px;
            padding-inline: 4px;
            color: var(--text-strong);
            background: var(--bg);
            border: 1px solid var(--accent);
            border-radius: 2px;
            font: inherit;
        }
        .copy-btn {
            visibility: hidden;
            padding-inline: 4px;
            border: 0;
            line-height: 1;
            font-size: 12px;
            color: var(--muted);
            background: transparent;
            cursor: pointer;

            &:hover {
                color: var(--accent-600);
            }
        }
        .v-num {
            color: var(--c-num);
        }
        .v-bool {
            color: var(--c-bool);
        }
        .v-str {
            color: var(--c-str);
        }
        .v-null {
            color: var(--c-null);
        }
        .v-fn {
            color: var(--c-fn);
            font-style: italic;
        }
        .v-obj {
            color: var(--c-obj);
        }
        .empty {
            padding: 8px;
            font-style: italic;
            color: var(--muted);
        }
        .vuex-bar {
            padding: 4px 6px;
            border-block-end: 1px solid var(--border);
        }
        .mut-index {
            display: inline-block;
            min-inline-size: 16px;
            font-size: 10px;
            text-align: end;
            color: var(--muted);
        }
        .time-travel {
            display: inline-block;
            margin-block: 4px 8px;
        }
    `;
}

customElements.define('vue2-devtools-panel', Vue2DevtoolsPanel);
