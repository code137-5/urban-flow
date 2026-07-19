#version 300 es
#define SHADER_NAME particle-fragment

// NOTE: no `precision` statement (luma's prologue already declares it — a
// duplicate breaks strict mobile drivers) and no screen-space derivatives.

in float vAlpha;

out vec4 fragColor;

void main(void) {
  // Soft round sprite: bright core, feathered edge.
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha * particle.color.a * layer.opacity;
  if (a < 0.01) discard;
  // Premultiplied output for additive blending over the dark canvas.
  fragColor = vec4(particle.color.rgb * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
