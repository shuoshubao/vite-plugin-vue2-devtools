# vite-plugin-vue2-devtools

一个**仅用于开发环境**的 Vite 插件，为 Vue 2.6 应用注入一个悬浮的组件审查面板（devtools）。

面板基于 Shadow DOM + [lit](https://lit.dev/) 渲染，运行在页面同一上下文中，直接读取 Vue 组件实例，无需跨上下文桥接，也不依赖浏览器扩展。

## 特性

-   **组件树**：实时展示组件层级，支持搜索、展开/折叠、方向键导航
-   **状态审查**：查看选中组件的 `props` / `data` / `computed` / `attrs`，值可就地编辑、一键复制
-   **组件拾取器**：在页面上点选元素直接定位到对应组件；悬停高亮组件 DOM
-   **源码跳转**：调用 Vite 的 `/__open-in-editor` 在编辑器中打开组件源文件
-   **渲染函数**：查看组件的 `render` 函数源码
-   **Vuex**：查看 state 快照、时间旅行（time-travel）、提交历史
-   **悬浮面板**：可拖拽吸附到任意边缘，窗口缩放时自动保持在可视区域内
-   **兼容 externals**：即使 Vue 被外部化为全局变量（`vite-plugin-externals`），组件树也能正常刷新

## 环境要求

-   Vue `2.6.x`
-   Vite（`apply: 'serve'`，仅在 dev server 生效）
-   配合 [`vite-plugin-vue2`](https://github.com/vitejs/vite-plugin-vue2) 使用

## 安装

```bash
npm i -D vite-plugin-vue2-devtools
```

## 使用

在 `vite.config.js` 中注册插件：

```js
import { createVuePlugin } from 'vite-plugin-vue2';
import vueDevtools from 'vite-plugin-vue2-devtools';

export default {
    plugins: [createVuePlugin(), vueDevtools()]
};
```

启动 dev server 后，页面右下角会出现一个悬浮入口，点击即可打开审查面板。插件不接受任何配置项。

> 该插件仅在 `vite serve`（开发模式）下生效，`vite build` 时会被自动跳过，不会进入生产产物。

## 工作原理

-   插件通过 `transformIndexHtml` 把客户端脚本以 `head-prepend` 的方式注入到页面 `<head>` 最前面，**先于应用加载 Vue**，从而在 Vue 之前装好全局 devtools hook（`__VUE_DEVTOOLS_GLOBAL_HOOK__`）。
-   组件树通过遍历 DOM 上的 `el.__vue__` 反推得到，并借助 Vue 的 `flush` 事件与 `MutationObserver` 双重刷新，保证在各种构建形态下都能保持同步。
-   面板与页面处于同一 realm，可直接读取组件实例的响应式数据，无需序列化桥接。

## License

[MIT](./LICENSE)
