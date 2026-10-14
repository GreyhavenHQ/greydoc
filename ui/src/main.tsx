import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ThemeProvider } from '@/lib/theme'
import { Toaster } from '@/components/ui/sonner'
import './index.css'

// A lazy chunk is gone after a server upgrade. Reload once to get the new build.
window.addEventListener('vite:preloadError', (e) => {
  if (sessionStorage.getItem('greydoc-reloaded') === location.href) return
  sessionStorage.setItem('greydoc-reloaded', location.href)
  e.preventDefault()
  location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster position="bottom-right" />
    </ThemeProvider>
  </StrictMode>,
)
