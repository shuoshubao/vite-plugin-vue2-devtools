// config.js — shared tunables for the devtools panel.

// localStorage key for persisted UI state (open/closed, tab, docked position).
export const StoreKey = 'vue-devtools:ui';

// Panel size (keep in sync with .panel CSS) — used to keep it on-screen.
export const PanelW = 620;
export const PanelH = 420;

// Margin between the floating entry and the viewport edge.
export const EdgeMargin = 12;

// Distance from the viewport edge to the panel when open (leaves room for the
// floating entry to sit in the gutter, matching the official devtools).
export const PanelEdge = EdgeMargin + 30 / 2;

// Pointer travel (px) before a press on the entry counts as a drag vs a click.
export const DragThreshold = 4;

// Show a per-section (props/data/computed/attrs…) filter input once a section
// has more than this many keys.
export const SectionFilterThreshold = 10;
