/// <reference types="vite/client" />

// Optional — without them the particles fall back to random trips (.env.example).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_ANON_KEY?: string
}

// GLSL shader sources imported as strings (via vite-plugin-glsl).
declare module '*.glsl' {
  const value: string
  export default value
}
declare module '*.vs' {
  const value: string
  export default value
}
declare module '*.fs' {
  const value: string
  export default value
}
declare module '*.vert' {
  const value: string
  export default value
}
declare module '*.frag' {
  const value: string
  export default value
}
