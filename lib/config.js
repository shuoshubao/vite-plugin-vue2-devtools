// config.js — shared tunables for the devtools panel.

// localStorage key for persisted UI state (open/closed, tab, docked position).
export const StoreKey = 'VitePluginDevTools';

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

// When collapsed, tuck the entry toward the edge after this idle time (ms)…
export const IdleTuckDelay = 3000;
// …by shrinking its edge margin to this (negative = peek partly off-screen).
export const IdleTuckMargin = -12;

export const openInEditor = file => {
    if (!file) {
        console.error('[vite-plugin-devtools] Cannot open editor: source file is empty.');
        return;
    }
    fetch('/__open-in-editor?file=' + encodeURIComponent(file))
        .then(response => {
            if (!response.ok) {
                throw new Error(`Request failed with status ${response.status}.`);
            }
        })
        .catch(error => {
            console.error('[vite-plugin-devtools] Failed to request editor launch:', error);
        });
};

export const launchEditor = (file, spawn) => {
    let openedWithCode = false;
    const openWithCode = () => {
        if (openedWithCode) {
            return;
        }
        openedWithCode = true;
        console.log(`[vite-plugin-devtools] Running: code -g ${file}`);
        const code = spawn('code', ['-g', file]);
        code.stderr.on('data', data => {
            console.error(`[vite-plugin-devtools] code stderr: ${data}`);
        });
        code.once('error', error => {
            console.error('[vite-plugin-devtools] Failed to start code:', error);
        });
        code.once('close', exitCode => {
            if (exitCode !== 0) {
                console.error(`[vite-plugin-devtools] code exited with status ${exitCode}.`);
            }
        });
    };
    console.log(`[vite-plugin-devtools] Running: comate --goto ${file}`);
    const comate = spawn('comate', ['--goto', file]);
    comate.stderr.on('data', data => {
        console.error(`[vite-plugin-devtools] comate stderr: ${data}`);
    });
    comate.once('error', error => {
        console.error('[vite-plugin-devtools] Failed to start comate:', error);
        openWithCode();
    });
    comate.once('close', exitCode => {
        if (exitCode !== 0) {
            console.error(`[vite-plugin-devtools] comate exited with status ${exitCode}.`);
            openWithCode();
        }
    });
};
