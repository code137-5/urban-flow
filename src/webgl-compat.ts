/**
 * WebGL shader-source compatibility shim for strict mobile GLSL ES compilers.
 *
 * deck.gl / luma.gl 9.3.x emit an illegal storage qualifier on an interface-block
 * member in every layer's shaders:
 *
 *     layout(std140) uniform layerUniforms {
 *       uniform float opacity;   // ← `uniform` is not allowed on a block member
 *     } layer;
 *
 * Desktop and ANGLE-based mobile drivers (iOS 15+ Safari, Android Chrome) tolerate
 * it, but stricter mobile GLSL ES compilers reject it with
 * "Compilation error in fragment shader …", breaking every deck.gl layer.
 *
 * We can't change deck.gl's generated source, so we intercept `gl.shaderSource`
 * — the single choke point every shader passes through before the driver sees it
 * — and strip illegal `uniform`/`in`/`out` qualifiers from interface-block members.
 * Import this module before any WebGL context is created (i.e. first in main.tsx).
 */

/** Remove illegal storage qualifiers from interface-block members. */
export function sanitizeShaderSource(src: string): string {
  // Match an interface block: `<qualifier> <BlockName> { …members… }`.
  // Uniform blocks contain no nested braces, so `[^{}]*` is a safe body match.
  return src.replace(
    /\b(uniform|buffer)\s+(\w+)\s*\{([^{}]*)\}/g,
    (_full, blockQualifier: string, blockName: string, body: string) => {
      // Strip a leading storage qualifier from each member declaration.
      const cleaned = body.replace(/(^|\n)(\s*)(?:uniform|in|out)\s+/g, '$1$2')
      return `${blockQualifier} ${blockName} {${cleaned}}`
    },
  )
}

function patchProto(proto: { shaderSource?: unknown } | undefined): void {
  if (!proto || !proto.shaderSource) return
  const p = proto as WebGL2RenderingContext & { __ufSanitized?: boolean }
  if (p.__ufSanitized) return
  const original = p.shaderSource
  p.shaderSource = function (this: WebGL2RenderingContext, shader, source) {
    return original.call(
      this,
      shader,
      typeof source === 'string' ? sanitizeShaderSource(source) : source,
    )
  }
  p.__ufSanitized = true
}

/** Install the shim on both WebGL2 and WebGL1 context prototypes (idempotent). */
export function installWebglCompat(): void {
  if (typeof window === 'undefined') return
  patchProto(window.WebGL2RenderingContext?.prototype)
  patchProto(window.WebGLRenderingContext?.prototype)
}

installWebglCompat()
