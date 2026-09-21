// panel.js — the floating inspector UI, a LitElement rendered inside a Shadow
// DOM overlay. It reads live Vue instances directly (same realm) and refreshes
// on every Vue scheduler flush.

import { LitElement, css, html } from 'lit';
import hook from './hook.js';
import { hide, highlight } from './inspector.js';
import { isPicking, startPicking, stopPicking } from './picker.js';
import { commitAll, getSnapshots, getStore, hasStore, travelTo, subscribe as vuexSubscribe } from './vuex.js';
import { buildTree, formatValue, getInstance } from './walker.js';

// Persisted UI state (survives reloads). Only stable, cheap bits — not the
// component tree / expanded set (ids are regenerated each load).
const STORE_KEY = 'vue-devtools:ui';

// Panel size (keep in sync with .panel CSS) — used to keep it on-screen.
const PANEL_W = 620;
const PANEL_H = 420;
const EDGE_MARGIN = 12;
// Distance from the viewport edge to the panel when open (leaves room for the
// floating entry to sit in the gutter, matching the official devtools).
const PANEL_EDGE = EDGE_MARGIN + 30 / 2;
const DRAG_THRESHOLD = 4;

export class VueDevToolsPanel extends LitElement {
    static properties = {
        tree: { state: true },
        selectedId: { state: true },
        expanded: { state: true },
        collapsed: { state: true },
        picking: { state: true },
        query: { state: true },
        tab: { state: true },
        vuexSelected: { state: true },
        renderCodeText: { state: true }
    };

    constructor() {
        super();
        const ui = VueDevToolsPanel._loadUiState();
        this.tree = [];
        this.selectedId = null;
        this.expanded = new Set();
        // Panel is closed by default; reopen state is remembered across reloads.
        this.collapsed = ui.collapsed !== undefined ? ui.collapsed : true;
        this.picking = false;
        this.query = '';
        this.tab = ui.tab || 'components';
        this.vuexSelected = 0;
        this.renderCodeText = null;
        this.valueExpanded = new Set();
        this.sectionCollapsed = new Set();
        // Docked position of the entry/panel. Defaults to the bottom edge near
        // the right; { edge: 'left'|'right'|'top'|'bottom', along: number }.
        this._pos = ui.pos || { edge: 'bottom', along: Number.POSITIVE_INFINITY };
        this._drag = null;
        this._editingPath = null;
        this._focusEdit = false;
        this._flushTimer = null;
        this._scrollToSelected = false;
        // DOM fallback: when Vue is externalized as a global build (e.g. via
        // vite-plugin-externals), the 'flush' hook may never fire — our
        // head-prepended hook can load after the global Vue, or a production
        // Vue build strips the devtools emit entirely. Watching the DOM for
        // added/removed nodes keeps the tree live regardless, since the tree is
        // derived from `el.__vue__` anyway.
        this._domObserver = null;
        this._onFlush = () => this._scheduleRefresh();
        this._onKeydown = e => this._handleKeydown(e);
        // Keep the entry/panel on-screen when the viewport shrinks. resize can
        // fire many times per second while dragging the window edge, and
        // _applyPos reads layout then writes styles — so coalesce to at most one
        // call per frame via rAF to avoid layout thrashing.
        this._resizeRaf = 0;
        this._onResize = () => {
            if (this._resizeRaf) return;
            this._resizeRaf = requestAnimationFrame(() => {
                this._resizeRaf = 0;
                this._applyPos();
            });
        };
    }

    static _loadUiState() {
        try {
            return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    _persistUiState() {
        try {
            const pos = this._pos && Number.isFinite(this._pos.along) ? this._pos : undefined;
            localStorage.setItem(STORE_KEY, JSON.stringify({ collapsed: this.collapsed, tab: this.tab, pos }));
        } catch (e) {
            /* storage unavailable — ignore */
        }
    }

    // Position the always-visible entry against its docked edge, and (when open)
    // the panel adjacent to it so the panel follows the entry. Both are fixed to
    // the viewport; clamped to stay fully on-screen.
    _applyPos() {
        const entry = this.renderRoot && this.renderRoot.querySelector('.entry');
        if (!entry) return;
        const p = this._pos || { edge: 'bottom', along: Number.POSITIVE_INFINITY };
        const M = EDGE_MARGIN;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const er = entry.getBoundingClientRect();
        const ew = er.width || 40;
        const eh = er.height || 40;
        const clamp = (v, max) => Math.min(Math.max(M, v), Math.max(M, max));

        // Clamped offset of the entry along its docked edge. We derive the panel
        // position from these numbers directly rather than re-reading the entry's
        // live rect — on a fresh open/refresh that rect can still be stale (reads
        // ~0), which left the entry bottom-right but the panel bottom-left.
        const alongX = clamp(p.along, vw - ew - M);
        const alongY = clamp(p.along, vh - eh - M);

        const es = entry.style;
        es.insetInlineStart = es.insetBlockStart = es.insetInlineEnd = es.insetBlockEnd = 'auto';
        if (p.edge === 'right' || p.edge === 'left') {
            es['inset' + (p.edge === 'right' ? 'InlineEnd' : 'InlineStart')] = M + 'px';
            es.insetBlockStart = alongY + 'px';
        } else {
            es['inset' + (p.edge === 'bottom' ? 'BlockEnd' : 'BlockStart')] = M + 'px';
            es.insetInlineStart = alongX + 'px';
        }
        this.setAttribute('dock', p.edge);

        const panel = this.renderRoot.querySelector('.panel');
        if (!panel) return;
        const ps = panel.style;
        ps.insetInlineStart = ps.insetBlockStart = ps.insetInlineEnd = ps.insetBlockEnd = 'auto';
        // Entry center along its edge, computed from the clamped offsets above.
        const cx = alongX + ew / 2;
        const cy = alongY + eh / 2;
        if (p.edge === 'right') {
            ps.insetInlineEnd = PANEL_EDGE + 'px';
            ps.insetBlockStart = clamp(cy - PANEL_H / 2, vh - PANEL_H - M) + 'px';
        } else if (p.edge === 'left') {
            ps.insetInlineStart = PANEL_EDGE + 'px';
            ps.insetBlockStart = clamp(cy - PANEL_H / 2, vh - PANEL_H - M) + 'px';
        } else if (p.edge === 'top') {
            ps.insetBlockStart = PANEL_EDGE + 'px';
            ps.insetInlineStart = clamp(cx - PANEL_W / 2, vw - PANEL_W - M) + 'px';
        } else {
            ps.insetBlockEnd = PANEL_EDGE + 'px';
            ps.insetInlineStart = clamp(cx - PANEL_W / 2, vw - PANEL_W - M) + 'px';
        }
    }

    // Drag the always-visible entry. Movement over a threshold = drag (live snap
    // to nearest edge, panel follows); a plain click toggles the panel.
    _startDrag(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        hide(); // clear any hover highlight before dragging
        const entry = this.renderRoot.querySelector('.entry');
        const rect = entry.getBoundingClientRect();
        this._drag = {
            startX: e.clientX,
            startY: e.clientY,
            offX: e.clientX - rect.left,
            offY: e.clientY - rect.top,
            moved: false
        };
        this._onDragMove = ev => this._dragMove(ev);
        this._onDragUp = ev => this._dragUp(ev);
        window.addEventListener('pointermove', this._onDragMove, true);
        window.addEventListener('pointerup', this._onDragUp, true);
    }

    _onFabPointerDown(e) {
        this._startDrag(e);
    }

    _dragMove(e) {
        const d = this._drag;
        if (!d) return;
        if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return;
        d.moved = true;
        // Snap to the nearest edge live during the drag (not on release).
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const dist = {
            left: e.clientX,
            right: vw - e.clientX,
            top: e.clientY,
            bottom: vh - e.clientY
        };
        const edge = Object.keys(dist).reduce((a, b) => (dist[b] < dist[a] ? b : a));
        const along = edge === 'left' || edge === 'right' ? e.clientY - d.offY : e.clientX - d.offX;
        this._pos = { edge, along };
        this._applyPos();
    }

    _dragUp() {
        window.removeEventListener('pointermove', this._onDragMove, true);
        window.removeEventListener('pointerup', this._onDragUp, true);
        const d = this._drag;
        this._drag = null;
        if (!d) return;
        if (!d.moved) {
            // plain click → toggle the panel
            this.collapsed = !this.collapsed;
            return;
        }
        // Position was already decided live in _dragMove; just remember it.
        this._persistUiState();
    }

    connectedCallback() {
        super.connectedCallback();
        hook.on('flush', this._onFlush);
        window.addEventListener('keydown', this._onKeydown, true);
        window.addEventListener('resize', this._onResize);
        this._vuexUnsub = vuexSubscribe(() => this.requestUpdate());
        // DOM-based fallback refresh (see constructor). Only childList/subtree —
        // our own panel renders inside a shadow root (not observed), and the
        // inspector highlight box only mutates via style, so this won't loop.
        this._domObserver = new MutationObserver(() => this._scheduleRefresh());
        this._domObserver.observe(document.body, { childList: true, subtree: true });
        // First paint may happen before the app has mounted; retry shortly.
        this.refresh();
        setTimeout(() => this.refresh(), 300);
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        hook.off('flush', this._onFlush);
        window.removeEventListener('keydown', this._onKeydown, true);
        window.removeEventListener('resize', this._onResize);
        if (this._resizeRaf) {
            cancelAnimationFrame(this._resizeRaf);
            this._resizeRaf = 0;
        }
        if (this._domObserver) {
            this._domObserver.disconnect();
            this._domObserver = null;
        }
        if (this._vuexUnsub) this._vuexUnsub();
        stopPicking();
    }

    firstUpdated() {
        this._applyPos();
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
        if (this._drag) return; // don't highlight while dragging the entry/panel
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
        // Persist remembered UI bits across reloads.
        if (changed && (changed.has('collapsed') || changed.has('tab'))) {
            this._persistUiState();
        }
        // Re-clamp the docked position when switching fab <-> panel (sizes differ).
        if (changed && changed.has('collapsed')) {
            this._applyPos();
        }
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
        // Single-line preview; full text is exposed via `title` since the value
        // is truncated with an ellipsis when it overflows the row.
        const preview = this._preview(value, keys);
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
                              title=${preview}
                              @click=${e => {
                                  if (!canEdit) return;
                                  e.stopPropagation();
                                  this._editingPath = path;
                                  this._focusEdit = true;
                                  this.requestUpdate();
                              }}
                          >
                              ${preview}
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
        const file = vm.$options && vm.$options.__file;
        // Only offer "open in editor" for project source files. Library
        // components (el-table etc.) either carry no __file or point into
        // node_modules — like the official devtools, don't show it for those.
        const canOpen = !!file && !/[\\/]node_modules[\\/]/.test(file);
        return html`
            <div class="detail-head">
                <span class="detail-name">&lt;${this._vmName(vm)}&gt;</span>
                <span class="detail-actions">
                    <button class="btn" @click=${() => this._scrollToComponent(vm)}>
                        ${this._icon('scroll')}
                        <span class="tip">Scroll to component</span>
                    </button>
                    <button class="btn" @click=${() => this._showRenderCode(vm)}>
                        ${this._icon('code')}
                        <span class="tip">Render code</span>
                    </button>
                    ${canOpen
                        ? html`
                              <button class="btn" @click=${() => this._openInEditor(file)}>
                                  ${this._icon('open')}
                                  <span class="tip">Open in editor</span>
                              </button>
                          `
                        : null}
                </span>
            </div>
            ${this._renderKvSection('props', propsObj, true)} ${this._renderKvSection('data', dataObj, true)}
            ${this._renderKvSection('computed', compObj, false)} ${this._renderKvSection('attrs', attrsObj, false)}
            ${!has
                ? html`
                      <div class="empty">No reactive state</div>
                  `
                : null}
        `;
    }

    _vmName(vm) {
        const o = vm.$options || {};
        let n = o.name || o._componentTag;
        if (!n && o.__file)
            n = String(o.__file)
                .split(/[\\/]/)
                .pop()
                .replace(/\.vue$/, '');
        if (!n && vm.$root === vm) n = 'Root';
        return n || 'Anonymous';
    }

    // Ask the Vite dev server to open the component's source file in the editor.
    _openInEditor(file) {
        if (!file) return;
        fetch('/__open-in-editor?file=' + encodeURIComponent(file)).catch(() => {});
    }

    // Scroll the component's root DOM element into view and flash the highlight.
    _scrollToComponent(vm) {
        const el = vm && vm.$el;
        if (!el || !el.scrollIntoView) return;
        el.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center'
        });
        highlight(vm);
        clearTimeout(this._scrollHlTimer);
        this._scrollHlTimer = setTimeout(() => hide(), 1000);
    }

    // Show the component's (compiled) render function source in an overlay.
    _showRenderCode(vm) {
        const fn = vm && vm.$options && vm.$options.render;
        this.renderCodeText = fn ? this._dedent(fn.toString()) : '// no render function on this component';
    }

    // fn.toString() keeps the source's original (often deep) indentation on every
    // line except the first. Strip the common leading whitespace so it reads flush.
    _dedent(code) {
        const lines = code.split('\n');
        let min = Infinity;
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const indent = lines[i].match(/^[ \t]*/)[0].length;
            if (indent < min) min = indent;
        }
        if (!isFinite(min) || min === 0) return code;
        return lines.map((l, i) => (i === 0 ? l : l.slice(min))).join('\n');
    }

    render() {
        return html`
            <div class="entry" @pointerdown=${e => this._onFabPointerDown(e)}>
                <span class="fab-icon">${this._vueLogo()}</span>
            </div>
            ${this.collapsed ? null : this._renderPanel()}
        `;
    }

    _renderPanel() {
        return html`
            <div class="panel">
                <nav class="sidebar">
                    <div class="logo">${this._vueLogo()}</div>
                    <button class="side-tab ${this.tab === 'components' ? 'active' : ''}" @click=${() => (this.tab = 'components')}>
                        ${this._icon('components')}
                        <span class="tip">Components</span>
                    </button>
                    <button class="side-tab ${this.tab === 'vuex' ? 'active' : ''}" @click=${() => (this.tab = 'vuex')}>
                        ${this._icon('vuex')}
                        <span class="tip">Vuex</span>
                    </button>
                    <span class="side-spacer"></span>
                    ${this.tab === 'components'
                        ? html`
                              <button class="side-tab ${this.picking ? 'active' : ''}" @click=${() => this._togglePick()}>
                                  ${this._icon('pick')}
                                  <span class="tip">${this.picking ? 'Cancel pick (Esc)' : 'Pick element'}</span>
                              </button>
                          `
                        : null}
                    <button class="side-tab" @click=${() => (this.collapsed = true)}>
                        ${this._icon('min')}
                        <span class="tip">Minimize</span>
                    </button>
                </nav>
                <div class="main">${this.tab === 'components' ? this._renderComponents() : this._renderVuex()}</div>
                ${this.renderCodeText != null
                    ? html`
                          <div class="code-overlay">
                              <div class="code-head">
                                  <span>Render code</span>
                                  <button class="btn" @click=${() => (this.renderCodeText = null)}>${this._icon('close')}</button>
                              </div>
                              <pre class="code-body">${this.renderCodeText}</pre>
                          </div>
                      `
                    : null}
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
            <svg viewBox="0 0 246.52 208.87" aria-hidden="true">
                <linearGradient
                    id="vdt-logo-1"
                    gradientUnits="userSpaceOnUse"
                    x1="-3449.4177"
                    y1="3349.6663"
                    x2="-3229.0247"
                    y2="3349.6663"
                    gradientTransform="matrix(-1 0 0 -1 -3219.187 3476.3691)"
                >
                    <stop offset="0.0053" stop-color="#008FC1" />
                    <stop offset="1" stop-color="#00F879" />
                </linearGradient>
                <linearGradient id="vdt-logo-2" gradientUnits="userSpaceOnUse" x1="22.5895" y1="139.0657" x2="213.6784" y2="32.6144">
                    <stop offset="0" stop-color="#00FFFF" />
                    <stop offset="0.3711" stop-color="#52F3AB" />
                    <stop offset="1" stop-color="#D9E021" />
                </linearGradient>
                <polygon fill="url(#vdt-logo-1)" points="120.03,212.11 230.23,41.3 9.84,41.3" />
                <path
                    fill="url(#vdt-logo-2)"
                    d="M242.01,37c-0.04-0.11-0.08-0.22-0.13-0.33c-0.6-1.25-1.9-1.89-3.31-2.28c0,0-0.01-0.01-0.01-0.01c-1.49-0.4-3.42-0.57-5.76-0.51c-0.03-0.01-0.06-0.01-0.08,0c-4.16,0.12-8.13,0.76-12.39,1.57c-0.01,0-0.01,0-0.02,0.01c-4.54,0.88-9.18,2.04-13.73,3.29c-0.94,0.26-1.9,0.53-2.87,0.8c-0.07,0.01-0.13,0.04-0.19,0.06c-1.04,0.3-2.09,0.61-3.17,0.93c-0.02,0-0.04,0.01-0.06,0.01c-12.55,3.75-25.12,8.24-37.45,13.03c0,0,0,0,0,0c0,0,0,0-0.01,0c-0.14,0-15.72-5.1-15.86-5.13c-0.61-0.2-0.92-0.88-0.68-1.47l6.23-15.29c0.1-0.26,0.3-0.47,0.56-0.59l20.96-9.74C118.88-27.47,29.43,12.85,30.45,87.28l23.77-11.77C53.03,46.21,87.14,29.34,109.7,48.1L88.08,58.77l-6.17,18.28l15.77,5.3l0.01,0.01l2.56,0.86l21.58-10.68c1.5,29.11-33.18,46.21-55.44,27.41l-15.76,7.8c-4.95,2.95-9.86,6.01-14.65,9.15c-0.01,0.01-0.01,0.01-0.01,0.01c-1.19,0.78-2.35,1.55-3.47,2.31c-0.01,0-0.01,0-0.01,0.01c-4.57,3.09-9.06,6.32-13.15,9.62c-0.05,0.03-0.1,0.07-0.14,0.11c-0.42,0.34-0.82,0.67-1.22,1c0,0,0,0,0,0c-1.47,1.21-2.91,2.47-4.29,3.76c-0.21,0.2-0.42,0.39-0.62,0.6c-0.71,0.67-1.37,1.34-1.96,1.98c-0.01,0.01-0.02,0.01-0.03,0.03c-0.26,0.28-0.51,0.56-0.75,0.82c-0.03,0.03-0.05,0.06-0.07,0.09c-0.14,0.16-0.27,0.31-0.4,0.46c-0.13,0.15-0.26,0.3-0.38,0.45c-0.38,0.44-0.71,0.88-1.02,1.31c-0.39,0.53-0.74,1.08-1.05,1.63c-0.47,0.81-0.84,1.67-1.02,2.52c-0.02,0.09-0.04,0.18-0.05,0.27c0,0.04-0.01,0.09-0.01,0.13c-0.45,5.19,7.2,4.85,11.33,4.65c0.69-0.04,1.37-0.1,2.06-0.18c0.39-0.04,0.79-0.08,1.19-0.13c0.34-0.04,0.68-0.08,1.03-0.13c9.58-1.34,18.99-3.95,28.3-6.74c56.32,67.3,166.12,18.25,152.23-69.41c11.24-6.86,22.67-14.75,29.27-20.46c2.91-2.52,5.74-5.12,8.02-8.12c0.11-0.14,0.22-0.28,0.31-0.42c0.2-0.28,0.39-0.56,0.56-0.83c0.38-0.61,0.75-1.24,1.02-1.89c0.04-0.1,0.08-0.19,0.12-0.29c0.04-0.1,0.08-0.21,0.11-0.3C242.21,38.72,242.26,37.79,242.01,37z"
                />
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
            case 'open':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M15 3h6v6" />
                        <path d="M10 14 21 3" />
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    </svg>
                `;
            case 'scroll':
                return html`
                    <svg viewBox="64 64 896 896" fill="currentColor" aria-hidden="true">
                        <path
                            d="M136 384h56c4.4 0 8-3.6 8-8V200h176c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8H196c-37.6 0-68 30.4-68 68v180c0 4.4 3.6 8 8 8zm512-184h176v176c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8V196c0-37.6-30.4-68-68-68H648c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8zM376 824H200V648c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v180c0 37.6 30.4 68 68 68h180c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zm512-184h-56c-4.4 0-8 3.6-8 8v176H648c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h180c37.6 0 68-30.4 68-68V648c0-4.4-3.6-8-8-8zm16-164H120c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8z"
                        />
                    </svg>
                `;
            case 'code':
                return html`
                    <svg viewBox="64 64 896 896" fill="currentColor" aria-hidden="true">
                        <path
                            d="M516 673c0 4.4 3.4 8 7.5 8h185c4.1 0 7.5-3.6 7.5-8v-48c0-4.4-3.4-8-7.5-8h-185c-4.1 0-7.5 3.6-7.5 8v48zm-194.9 6.1l192-161c3.8-3.2 3.8-9.1 0-12.3l-192-160.9A7.95 7.95 0 00308 351v62.7c0 2.4 1 4.6 2.9 6.1L420.7 512l-109.8 92.2a8.1 8.1 0 00-2.9 6.1V673c0 6.8 7.9 10.5 13.1 6.1zM880 112H144c-17.7 0-32 14.3-32 32v736c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V144c0-17.7-14.3-32-32-32zm-40 728H184V184h656v656z"
                        />
                    </svg>
                `;
            case 'close':
                return html`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
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
            inset: 0;
            pointer-events: none;
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            font-size: 12px;
            color: var(--text);
        }
        .entry {
            position: fixed;
            pointer-events: auto;
            z-index: 2;
            display: flex;
            align-items: center;
            gap: 2px;
            padding: 7px;
            border-radius: 10px;
            cursor: grab;
            touch-action: none;
            user-select: none;
            background: var(--bg);
            border: 1px solid var(--border-strong);
            box-shadow: 0 6px 20px rgb(16 24 40 / 0.18);
        }
        .entry:active {
            cursor: grabbing;
        }
        .fab-icon {
            display: grid;
            place-items: center;
            inline-size: 16px;
            block-size: 16px;
        }
        .fab-icon svg {
            inline-size: 16px;
            block-size: 16px;
        }
        /* On the left/right edges, stack the entry's icons vertically. */
        :host([dock='left']) .entry,
        :host([dock='right']) .entry {
            flex-direction: column;
        }
        .panel {
            position: fixed;
            pointer-events: auto;
            z-index: 1;
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
            position: relative;
            z-index: 2;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            padding-block: 8px;
            background: var(--surface);
            border-inline-end: 1px solid var(--border);
        }
        .logo {
            display: grid;
            place-items: center;
            inline-size: 34px;
            block-size: 34px;
            margin-block-end: 4px;
            border-radius: 9px;

            & svg {
                inline-size: 22px;
                block-size: 22px;
                display: block;
            }
        }
        .side-tab {
            position: relative;
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

            & .tip {
                inset-inline-start: calc(100% + 8px);
                inset-block-start: 50%;
                translate: -4px -50%;

                &::before {
                    content: '';
                    position: absolute;
                    inset-inline-end: 100%;
                    inset-block-start: 50%;
                    translate: 0 -50%;
                    border: 4px solid transparent;
                    border-inline-end-color: #1f2937;
                }
            }
            &:hover .tip {
                translate: 0 -50%;
            }
        }
        .tip {
            position: absolute;
            z-index: 20;
            padding: 3px 8px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
            line-height: 1.4;
            white-space: nowrap;
            color: #fff;
            background: #1f2937;
            box-shadow: 0 4px 12px rgb(16 24 40 / 0.25);
            pointer-events: none;
            opacity: 0;
            transition:
                opacity 0.12s ease,
                translate 0.12s ease;
        }
        .btn .tip {
            inset-block-start: calc(100% + 6px);
            inset-inline-end: 0;
        }
        :is(.side-tab, .btn):hover > .tip {
            opacity: 1;
        }
        .side-spacer {
            flex: 1;
        }
        .main {
            position: relative;
            z-index: 1;
            display: flex;
            flex-direction: column;
            min-inline-size: 0;
            min-block-size: 0;
            overflow: hidden;
        }
        .btn {
            position: relative;
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
        .detail-head {
            display: flex;
            align-items: center;
            gap: 6px;
            padding-block-end: 4px;
            margin-block-end: 4px;
            border-block-end: 1px solid var(--border);

            & .detail-name {
                font-weight: 600;
                color: var(--accent-600);
            }
            & .detail-actions {
                display: flex;
                gap: 2px;
                margin-inline-start: auto;

                & .btn {
                    padding: 2px 5px;
                }
                & .btn svg {
                    inline-size: 15px;
                    block-size: 15px;
                }
            }
        }
        .code-overlay {
            position: absolute;
            inset-block: 0;
            inset-inline: 48px 0;
            z-index: 5;
            display: flex;
            flex-direction: column;
            background: var(--bg);

            & .code-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 10px;
                font-weight: 600;
                color: var(--text-strong);
                border-block-end: 1px solid var(--border);

                & .btn {
                    padding: 0;
                    inline-size: 26px;
                    block-size: 26px;
                    align-items: center;
                    justify-content: center;
                }
            }
            & .code-body {
                flex: 1;
                margin: 0;
                overflow: auto;
                padding: 10px 12px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 12px;
                line-height: 1.5;
                color: var(--c-obj);
                white-space: pre;
                tab-size: 2;
            }
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
            flex: 0 1 auto;
            min-inline-size: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;

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
            flex-shrink: 0;
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

customElements.define('vue-devtools-panel', VueDevToolsPanel);
