// Must run before any WebGL context/shader is created — see webgl-compat.ts.
import './webgl-compat'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initDebugConsole } from './debug'

// Before render so eruda captures early logs; a load failure must not block the app.
await initDebugConsole().catch((err) => {
  console.warn('debug console failed to init', err)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
