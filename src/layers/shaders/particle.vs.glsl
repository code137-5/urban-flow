#version 300 es
#define SHADER_NAME particle-vertex

// Render pass reads particle state straight from the ping-pong buffer -- no
// texture fetch anywhere in this stage (the transform step bakes the terrain
// height into positions.z, honoring the same "bake, don't fetch" rule as the
// terrain mesh).

in vec4 positions; // xy = heightmap UV, z = height [0,1] (-1 = hidden), w = age
in vec2 seeds;

out float vAlpha;

void main(void) {
  vec2 lnglat = particle.bounds.xy + positions.xy * particle.bounds.zw;
  float hidden = step(positions.z, -0.5);
  // z in meters; zOffset floats sprites just above the contour surface.
  vec3 pos = vec3(lnglat, max(positions.z, 0.0) * particle.scale.z + particle.scale.w);

  geometry.worldPosition = pos;
  geometry.uv = vec2(0.0);
  gl_Position = project_position_to_clipspace(pos, vec3(0.0), vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  // Fade in at spawn, fade out toward expiry (fade window in frames).
  float fadeIn = smoothstep(0.0, particle.lifecycle.w, positions.w);
  float fadeOut = 1.0 - smoothstep(particle.lifecycle.x - particle.lifecycle.w,
                                   particle.lifecycle.x, positions.w);
  vAlpha = fadeIn * fadeOut * (1.0 - hidden);

  // Slight per-particle size variation from the static seed. Doubled so the
  // fragment shader has room for a wide glow halo around the core dot --
  // overlapping halos accumulate under additive blending.
  gl_PointSize =
    particle.sprite.x * (1.0 - 0.5 * particle.sprite.y + particle.sprite.y * seeds.x) * 2.0;

  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
}
