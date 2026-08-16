#version 300 es
#define SHADER_NAME particle-fragment

// NOTE: no `precision` statement (luma's prologue already declares it -- a
// duplicate breaks strict mobile drivers) and no screen-space derivatives.

in float vAlpha;

out vec4 fragColor;

void main(void) {
  // Two-lobe sprite: a bright core in the inner half plus a wide, faint halo
  // filling the (doubled) point. Under additive blending the halos of nearby
  // particles stack, so overlaps visibly bloom -- sprite.z tunes the strength.
  float dist = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.25, 0.06, dist);
  float falloff = max(1.0 - dist * 2.0, 0.0);
  float halo = falloff * falloff;
  float glow = core + particle.sprite.z * halo * 0.5;
  float a = glow * vAlpha * particle.color.a * layer.opacity;
  if (a < 0.01) discard;
  // Premultiplied output for additive blending over the dark canvas.
  fragColor = vec4(particle.color.rgb * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
