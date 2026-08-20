/// <reference types="vite/client" />
import type { KarakeepPreloadApi } from '../../preload/index'

declare global {
  interface Window {
    kk: KarakeepPreloadApi
  }
}

export {}
