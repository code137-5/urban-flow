#version 300 es
#define SHADER_NAME contour-terrain-fragment

// NOTE: no `precision` statement here on purpose — luma.gl's assembled prologue
// already declares `precision highp float;` for the fragment stage. Declaring it
// again duplicates it, which some strict mobile GLSL ES drivers reject (desktop
// and ANGLE tolerate it). The base map layers don't redeclare precision, and
// they compile on the affected device — so this duplicate is a prime suspect.

in float vHeight;
in float vMask;
in float vSlope;

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

  // Slope-invariant thickness: a fixed height band maps to a screen width that
  // scales with 1/slope (thick on flats, thin on steeps). Dividing the
  // height-space distance by the local |∇h| (baked per-vertex, ~1.0 at a
  // typical slope) turns `f` into a per-unit-distance metric, so every contour
  // renders at the same apparent thickness. Clamp the factor: the floor keeps
  // gentle slopes from vanishing, the ceiling stops steeps from fattening past
  // the mid-interval and merging (and both guard the divide). Derivative-free.
  float slope = clamp(vSlope, 0.4, 4.0);
  float d = f / slope;
  float line = 1.0 - smoothstep(terrain.lineWidth, terrain.lineWidth + 0.03, d);
  if (line < 0.02) discard; // keep only the lines; surface between is transparent

  vec3 color = mix(terrain.lineColor, terrain.peakColor, vHeight).rgb;
  fragColor = vec4(color, line * layer.opacity);

  DECKGL_FILTER_COLOR(fragColor, geometry);
}
