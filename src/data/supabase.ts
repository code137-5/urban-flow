import type { SupabaseClient } from '@supabase/supabase-js'

let client: Promise<SupabaseClient | null> | null = null

/**
 * Shared Supabase client, or `null` when the `VITE_SUPABASE_*` env vars are not
 * set. Read-only anon access — no auth session. The SDK is imported lazily so it
 * stays out of the landing bundle; only the dashboard's trip source pulls it in.
 */
export function getSupabase(): Promise<SupabaseClient | null> {
  client ??= (async () => {
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY
    if (!url || !key) return null
    const { createClient } = await import('@supabase/supabase-js')
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  })()
  return client
}
