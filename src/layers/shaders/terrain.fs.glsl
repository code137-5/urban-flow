#version 300 es
#define SHADER_NAME contour-terrain-fragment

precision highp float;

in float vHeight;
in float vMask;

out vec4 fragColor;

void main(void) {
  // Discard masked cells (outside Seoul / inside the Han river).
  if (vMask < 0.5) discard;

  // Flat ground at the noise floor has no real contour crossing, but the
  // 0-level line sits exactly on it and would fill it solid. Drop everything
  // below the first interval so only genuine rings around hotspots remain.
  if (vHeight < terrain.interval * 0.5) discard;

  // Contour lines WITHOUT screen-space derivatives. `fwidth`/`dFdx` are a
  // common mobile GLSL ES compile-failure class (strict drivers reject them
  // even under #version 300 es), and this is the only layer that used them —
  // hence the terrain-only shader error on mobile. Instead, measure the
  // distance to the nearest contour directly in height-interval units and
  // soften with smoothstep. `lineWidth` is the line half-width in those units.
  float h = vHeight / terrain.interval;
  float f = abs(fract(h - 0.5) - 0.5); // 0 on a contour, 0.5 midway between
  float line = 1.0 - smoothstep(terrain.lineWidth, terrain.lineWidth + 0.03, f);
  if (line < 0.02) discard; // keep only the lines; surface between is transparent

  vec3 color = mix(terrain.lineColor, terrain.peakColor, vHeight);
  fragColor = vec4(color, line * layer.opacity);

  DECKGL_FILTER_COLOR(fragColor, geometry);
}
