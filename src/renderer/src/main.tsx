import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { applyTheme, readPref, type ThemePref } from './lib/prefs'
import './styles/index.css'

// Before the first render, not in an effect: `darkMode: 'class'` means the
// page paints light until `.dark` lands on <html>, so applying this from a
// mounted effect would flash white on every launch for dark-mode users.
applyTheme(readPref<ThemePref>('theme', 'system'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
