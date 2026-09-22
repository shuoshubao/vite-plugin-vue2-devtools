// config.js — shared tunables for the devtools panel.

// localStorage key for persisted UI state (open/closed, tab, docked position).
export const STORE_KEY = 'vue-devtools:ui';

// Panel size (keep in sync with .panel CSS) — used to keep it on-screen.
export const PANEL_W = 620;
export const PANEL_H = 420;

// Margin between the floating entry and the viewport edge.
export const EDGE_MARGIN = 12;

// Distance from the viewport edge to the panel when open (leaves room for the
// floating entry to sit in the gutter, matching the official devtools).
export const PANEL_EDGE = EDGE_MARGIN + 30 / 2;

// Pointer travel (px) before a press on the entry counts as a drag vs a click.
export const DRAG_THRESHOLD = 4;

// Show a per-section (props/data/computed/attrs…) filter input once a section
// has more than this many keys.
export const SECTION_FILTER_THRESHOLD = 10;
