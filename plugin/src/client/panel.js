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
                        class="arrow ${hasChildren ? '' : 'hidden'} ${isOpen ? 'open' : ''}"
                        @click=${e => {
                            e.stopPropagation();
                            this._toggle(node.id);
                        }}
                    >
                        ▶
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
                    <span class="arrow ${kids.length ? 'open' : 'hidden'}">▶</span>
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
            <div class="section-title" @click=${() => this._toggleSection(title)}>
                <span class="sarrow ${collapsed ? '' : 'open'}">▶</span>
                ${title}
            </div>
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
                <span class="varrow ${expandable ? '' : 'hidden'} ${open ? 'open' : ''}">▶</span>
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
    // over plain http (e.g. http://a.baidu.com:5000) fall back to execCommand.
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
                <div class="fab" @click=${() => (this.collapsed = false)}>Vue2</div>
            `;
        }
        return html`
            <div class="panel">
                <div class="header">
                    <button class="tab ${this.tab === 'components' ? 'active' : ''}" @click=${() => (this.tab = 'components')}>Components</button>
                    <button class="tab ${this.tab === 'vuex' ? 'active' : ''}" @click=${() => (this.tab = 'vuex')}>Vuex</button>
                    <span class="spacer"></span>
                    ${this.tab === 'components'
                        ? html`
                              <button class="btn ${this.picking ? 'on' : ''}" title="Pick element on page (Esc to cancel)" @click=${() => this._togglePick()}>
                                  ⌖
                              </button>
                          `
                        : null}
                    <button class="btn" title="Minimize" @click=${() => (this.collapsed = true)}>─</button>
                </div>
                ${this.tab === 'components' ? this._renderComponents() : this._renderVuex()}
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
        .tab {
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            color: #b0bec5;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            padding: 2px 4px;
        }
        .tab:hover {
            color: #fff;
        }
        .tab.active {
            color: #41b883;
            border-bottom-color: #41b883;
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
            display: flex;
            align-items: center;
            gap: 3px;
            color: #9e9e9e;
            font-weight: 500;
            margin: 8px 0 2px;
            cursor: pointer;
            text-transform: lowercase;
        }
        .section-title:hover {
            color: #cfd8dc;
        }
        .sarrow {
            display: inline-block;
            width: 9px;
            font-size: 7px;
            color: #9e9e9e;
            transition: transform 0.1s;
        }
        .sarrow.open {
            transform: rotate(90deg);
        }
        .vrow {
            display: flex;
            align-items: baseline;
            gap: 3px;
            padding: 1px 0;
            white-space: nowrap;
            line-height: 17px;
        }
        .vrow.expandable {
            cursor: pointer;
        }
        .varrow {
            display: inline-block;
            width: 9px;
            font-size: 7px;
            color: #90a4ae;
            transition: transform 0.1s;
            flex: none;
        }
        .varrow.open {
            transform: rotate(90deg);
        }
        .varrow.hidden {
            visibility: hidden;
        }
        .key {
            color: #80cbc4;
        }
        .colon {
            color: #789;
        }
        .val {
            word-break: break-all;
            white-space: normal;
        }
        .val.editable {
            cursor: text;
            border-radius: 2px;
        }
        .val.editable:hover {
            background: rgba(65, 184, 131, 0.15);
            box-shadow: 0 0 0 1px rgba(65, 184, 131, 0.4);
        }
        .edit-input {
            background: #1c1c1c;
            border: 1px solid #41b883;
            border-radius: 2px;
            color: #e8e8e8;
            font: inherit;
            padding: 0 4px;
            min-width: 60px;
        }
        .copy-btn {
            visibility: hidden;
            background: transparent;
            border: none;
            color: #90a4ae;
            cursor: pointer;
            font-size: 12px;
            padding: 0 4px;
            line-height: 1;
        }
        .copy-btn:hover {
            color: #41b883;
        }
        .vrow:hover .copy-btn {
            visibility: visible;
        }
        .v-num {
            color: #ffcb6b;
        }
        .v-bool {
            color: #c792ea;
        }
        .v-str {
            color: #c3e88d;
        }
        .v-null {
            color: #f78c6c;
        }
        .v-fn {
            color: #82aaff;
            font-style: italic;
        }
        .v-obj {
            color: #b0bec5;
        }
        .empty {
            color: #789;
            padding: 8px;
            font-style: italic;
        }
        .vuex-bar {
            padding: 4px 6px;
            border-bottom: 1px solid #3a3a3a;
        }
        .mut-index {
            display: inline-block;
            min-width: 16px;
            color: #90a4ae;
            font-size: 10px;
            text-align: right;
        }
        .node.selected .mut-index {
            color: #17222b;
        }
        .time-travel {
            margin: 4px 0 8px;
            display: inline-block;
        }
    `;
}

customElements.define('vue2-devtools-panel', Vue2DevtoolsPanel);
