import { shaderErrors } from './webgl-compat'
import type { ShaderError } from './webgl-compat'

const STORAGE_KEY = 'uf-debug'

/** Cached module promise — the probe chunk is fetched at most once. */
let probesModule: Promise<typeof import('./debugProbes')> | undefined
function loadProbes(): Promise<typeof import('./debugProbes')> {
  return (probesModule ??= import('./debugProbes'))
}

/** Each error is autopsied exactly once, even if it arrives twice. */
const seenErrors = new WeakSet<ShaderError>()
/**
 * Post-mortems compile shaders on the very context that just failed, so they
 * must never overlap: they run one at a time on this tail-chained queue.
 */
let postMortemQueue: Promise<void> = Promise.resolve()

function queuePostMortem(err: ShaderError): void {
  if (!err || typeof err !== 'object' || seenErrors.has(err)) return
  seenErrors.add(err)
  postMortemQueue = postMortemQueue.then(async () => {
    try {
      const { runPostMortem } = await loadProbes()
      await runPostMortem(err)
    } catch (e) {
      console.warn('post-mortem failed to run', e)
    }
  })
}

function listenForShaderErrors(): void {
  window.addEventListener('uf-shader-error', (e) => {
    queuePostMortem((e as CustomEvent<ShaderError>).detail)
  })
  // Failures captured before this listener existed (import/eval order) still
  // deserve an autopsy.
  for (const err of shaderErrors) queuePostMortem(err)
}

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

  // Post-mortem wiring goes up FIRST, before the (awaited) eruda/probe imports:
  // a shader can fail while those chunks are still in flight, and that first
  // failure is the one we most need to autopsy. Anything captured before this
  // point is drained explicitly below.
  listenForShaderErrors()

  // Dynamic import keeps the eruda chunk out of the normal-visitor bundle.
  const { default: eruda } = await import('eruda')
  eruda.init()

  // Shader probe lab: bisects which GLSL construct a mobile driver rejects.
  // Dynamically imported AFTER eruda so its output is visible on-device, and
  // only inside this debug-gated branch — normal visitors never fetch it.
  try {
    const { runShaderProbes } = await import('./debugProbes')
    await runShaderProbes()
  } catch (err) {
    console.warn('shader probes failed to run', err)
  }
}
