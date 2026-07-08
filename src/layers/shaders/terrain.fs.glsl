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

  // Contour lines via fract + fwidth: distance (in fractions of an interval)
  // to the nearest contour, divided by its screen-space derivative for AA.
  float h = vHeight / terrain.interval;
  float dh = max(fwidth(h), 1e-4); // clamp: fwidth blows up past ~80 deg pitch
  float d = abs(fract(h - 0.5) - 0.5) / dh;
  float line = 1.0 - clamp(d / terrain.lineWidth, 0.0, 1.0);
  if (line < 0.02) discard; // keep only the lines; surface between is transparent

  vec3 color = mix(terrain.lineColor, terrain.peakColor, vHeight);
  fragColor = vec4(color, line * layer.opacity);

  DECKGL_FILTER_COLOR(fragColor, geometry);
}
