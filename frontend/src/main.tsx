import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { isNative } from './lib/connection'

if (isNative) {
  // Dark icons on a white status bar, matching the app header.
  void import('@capacitor/status-bar')
    .then(async ({ StatusBar, Style }) => {
      await StatusBar.setOverlaysWebView({ overlay: false })
      await StatusBar.setBackgroundColor({ color: '#ffffff' })
      await StatusBar.setStyle({ style: Style.Light })
    })
    .catch(() => undefined)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
