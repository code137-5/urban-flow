const STORAGE_KEY = 'uf-debug'

// Exact trailing segment: '/debug', '/foo/debug' — not '/debugger'.
function isDebugPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '').endsWith('/debug')
}

function hasStoredFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export async function initDebugConsole(): Promise<void> {
  const params = new URLSearchParams(window.location.search)

  if (params.get('debug') === 'off') {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Safari private mode throws on storage access.
    }
    return
  }

  const viaPath = isDebugPath(window.location.pathname)
  const viaQuery = params.has('debug')
  if (!viaPath && !viaQuery && !hasStoredFlag()) return

  if (viaPath || viaQuery) {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // Safari private mode throws on storage access.
    }
  }

  // Dynamic import keeps the eruda chunk out of the normal-visitor bundle.
  const { default: eruda } = await import('eruda')
  eruda.init()
}
