#version 300 es
#define SHADER_NAME particle-update-vertex

// Transform-feedback step -- places every particle on its trip for the current
// simulation time. Rasterization is discarded; the only output is `outPosition`,
// captured into the ping-pong state buffer the render pass reads. Position is a
// pure function of time (no dependence on the previous state), so the CPU can
// predict exactly when a trip ends and swap in the next one (ParticleLayer._step).
// The flow texture is the one vertex-stage texture read in the app (WebGL2
// guarantees >=16 vertex texture units; particleSupport.ts probes this construct).

in vec4 inTrip;    // xy = origin UV, zw = destination UV (heightmap space)
in vec2 inTiming;  // x = duration (s at timeScale 1), y = start time (sim s)

out vec4 outPosition; // xy = UV, z = height [0,1] (-1 = hidden), w = progress 0..1

// Only B (height) and A (Seoul mask) are read here; R,G (gradient) are unused
// by the trip model and kept for texture-format compatibility.
uniform sampler2D flowTexture;

void main(void) {
  // Playback duration: timeScale (motion.x) compresses real-world trip times.
  float dur = max(inTiming.x, 1e-3) / particle.motion.x;
  float progress = clamp((particle.lifecycle.y - inTiming.y) / dur, 0.0, 1.0);
  vec2 uv = mix(inTrip.xy, inTrip.zw, progress);

  vec4 f = texture(flowTexture, uv);
  // A straight line can cut across a concave stretch of the boundary -- hide
  // the sprite while it is outside Seoul instead of floating it over nothing.
  float hidden = step(f.a, 0.5);
  outPosition = vec4(uv, mix(f.b, -1.0, hidden), progress);
}
