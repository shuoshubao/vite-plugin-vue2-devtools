import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to the browser-side entry that gets injected into the page.
// It must run BEFORE the app imports Vue, so we inject it at the top of <head>.
const CLIENT_ENTRY = resolve(__dirname, 'main.js');

// Root of this plugin package — needed so Vite's dev server is allowed to
// serve the plugin's own files that live outside the demo project root.
const PLUGIN_ROOT = __dirname;

/**
 * vite-plugin-vue-devtools
 *
 * Dev-only plugin. Injects a small client bundle that hooks into the Vue 2.6
 * global devtools hook, walks the component tree and renders a floating
 * inspector panel (Shadow DOM + lit) living in the same page realm — so it can
 * read component instances directly without any cross-context bridge.
 *
 * @returns {import('vite').Plugin}
 */
const vueDevTools = () => {
    return {
        name: 'vite-plugin-vue-devtools',
        // Inspector is a development aid only; never touch the production build.
        apply: 'serve',

        config() {
            return {
                server: {
                    fs: {
                        // Setting `fs.allow` replaces Vite's default (which includes the
                        // project/workspace root), so we must re-add it — otherwise the
                        // app's own /src files get a 403. Plus this package's own dir so
                        // the injected client can be served from outside the demo root.
                        allow: [searchForWorkspaceRoot(process.cwd()), PLUGIN_ROOT]
                    }
                }
            };
        },

        transformIndexHtml() {
            return [
                {
                    tag: 'script',
                    attrs: {
                        type: 'module',
                        // `/@fs/` lets Vite serve + transform a file by absolute path.
                        src: `/@fs/${CLIENT_ENTRY}`
                    },
                    // head-prepend => this module script executes before the app's
                    // module script, so our global hook is installed before Vue loads.
                    injectTo: 'head-prepend'
                }
            ];
        }
    };
};

export default vueDevTools;
