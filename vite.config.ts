import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { devMetadata } from './server/devMetadata'

/**
 * The production layout: the landing page at /, the app at /app/. Both stay on architex.fun, one origin, so the
 * passkeys, browser wallets and settings people saved before the move are all still there. The landing's source is
 * public/home/index.html (the dev server keeps the app at / and the landing at /home/); the build moves both pages.
 */
function landingAtRoot(): Plugin {
  let outDir = ''
  return {
    name: 'architex:landing-at-root',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const home = path.join(outDir, 'home')
      const landing = path.join(home, 'index.html')
      const app = path.join(outDir, 'index.html')
      if (!fs.existsSync(landing) || !fs.existsSync(app)) return
      fs.mkdirSync(path.join(outDir, 'app'), { recursive: true })
      fs.renameSync(app, path.join(outDir, 'app', 'index.html'))
      fs.renameSync(landing, app)
      if (fs.readdirSync(home).length === 0) fs.rmdirSync(home)
    },
  }
}

export default defineConfig({
  plugins: [react(), nodePolyfills(), devMetadata(), landingAtRoot()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    allowedHosts: true,
    cors: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('/node_modules/viem/') ||
            id.includes('/node_modules/wagmi/') ||
            id.includes('/node_modules/@wagmi/') ||
            id.includes('/node_modules/@tanstack/')
          ) {
            return 'vendor-web3'
          }
          if (id.includes('/node_modules/@circle-fin/') || id.includes('/node_modules/@solana/')) {
            return 'vendor-cctp'
          }
        },
      },
    },
  },
})
