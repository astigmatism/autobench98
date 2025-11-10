// apps/web/vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
    base: '/studio/',
    plugins: [vue()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    },
    server: {
        port: 5173,
        host: '0.0.0.0',
        proxy: {
            // forward WS upgrades to Fastify
            '/ws': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: true
            }
            // If you later add REST routes, you can also proxy '/api': { target: 'http://localhost:3000', changeOrigin: true }
        }
    }
})