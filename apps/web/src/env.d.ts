/// <reference types="vite/client" />

// Let TypeScript understand .vue single-file components
declare module '*.vue' {
    import type { DefineComponent } from 'vue'
    const component: DefineComponent<{}, {}, any>
    export default component
}