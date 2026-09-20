#version 300 es
#define SHADER_NAME particle-vertex

// Render pass reads particle state straight from the ping-pong buffer -- no
// texture fetch anywhere in this stage (the transform step bakes the terrain
// height into positions.z, honoring the same "bake, don't fetch" rule as the
// terrain mesh).

in vec4 positions; // xy = heightmap UV, z = height [0,1] (-1 = hidden), w = trip progress 0..1

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

  // Fade in leaving the origin, fade out approaching the destination. Progress
  // runs 0..1 (lifecycle.x = 1) and the window (lifecycle.w) is a fraction of the
  // trip. A finished particle parks at progress 1 -- fully faded -- until the CPU
  // hands it its next trip, so reassignment never pops.
  float fadeIn = smoothstep(0.0, particle.lifecycle.w, positions.w);
  float fadeOut = 1.0 - smoothstep(particle.lifecycle.x - particle.lifecycle.w,
                                   particle.lifecycle.x, positions.w);
  // Arrival ramp (lifecycle.z, 0..1): alpha climbs with progress, so a particle
  // leaves its origin faint and lands bright -- direction reads from a still
  // frame. 0 keeps the flat, symmetric fade. The short fade-out stays on top so a
  // landed particle still never pops. Trail ghosts carry their own older progress,
  // so the tail comes out fainter than the head for free.
  float ramp = mix(1.0, positions.w, particle.lifecycle.z);
  vAlpha = fadeIn * fadeOut * ramp * (1.0 - hidden);

  // Every particle is the same size -- one dot, one trip. The sprite is the core
  // dot times the halo scale (sprite.w, 2 by default), so the fragment shader has
  // room for a wide glow halo; overlapping halos accumulate under additive
  // blending, which is what makes busy corridors light up.
  gl_PointSize = particle.sprite.x * particle.sprite.w;

  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
}
