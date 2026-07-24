#version 300 es
#define SHADER_NAME particle-update-vertex

// Transform-feedback simulation step -- the whole particle "physics" lives here.
// Rasterization is discarded; the only output is the `outPosition` varying,
// captured into the ping-pong state buffer. The flow field is sampled from an
// rgba8 texture (the one vertex-stage texture read in the app; WebGL2 spec
// guarantees >=16 vertex texture units, and the probe exercises this exact
// construct before the layer is enabled).

in vec4 inPosition; // xy = heightmap UV, z = height [0,1] (-1 = hidden), w = age (frames)
in vec2 inSeed;     // static per-particle random seed

out vec4 outPosition;

uniform sampler2D flowTexture; // R,G = gradient (biased +/-1), B = height, A = Seoul mask

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main(void) {
  vec2 uv = inPosition.xy;
  float age = inPosition.w + 1.0;
  // Wrapped time seed -- keeps hash inputs small so float precision holds.
  float tSeed = fract(particle.lifecycle.y);

  vec4 f = texture(flowTexture, uv);
  vec2 grad = (f.rg - 0.5) * 2.0;
  float h = f.b;
  float inside = step(0.5, f.a);

  // Contour-following: the gradient rotated 90 degrees is the isoline tangent.
  // flowBlend (motion.z) mixes toward straight uphill for the tuner.
  vec2 tangent = vec2(-grad.y, grad.x);
  vec2 dir = mix(tangent, grad, particle.motion.z);

  // Per-frame hash jitter breaks up streamline clumping; scaled by the local
  // gradient so flat areas stay calm instead of buzzing in place.
  float ja = hash(inSeed + uv + tSeed) * 6.2831853;
  dir += particle.motion.y * vec2(cos(ja), sin(ja)) * max(length(grad), 0.05);

  // Normalize to unit direction so every particle travels at the configured
  // speed -- un-normalized, velocity scaled with |gradient| (<=1, often ~0.2),
  // which made motion crawl and squashed the trail ghosts into sub-pixel
  // spacing. Near-zero gradients (flats, peak plateaus) stay parked.
  float dirLen = length(dir);
  dir = dirLen > 1e-4 ? dir / dirLen : vec2(0.0);

  // meters/s -> UV/s per axis (lng/lat anisotropy corrected), x dt.
  vec2 newUv = uv + dir * particle.motion.x * particle.motion.w
             * vec2(particle.scale.x, particle.scale.y);

  bool expired = age >= particle.lifecycle.x;
  bool escaped = inside < 0.5 ||
    any(lessThan(newUv, vec2(0.0))) || any(greaterThan(newUv, vec2(1.0)));

  if (expired || escaped) {
    // Respawn at a hashed position; two unrolled retries to land in the mask.
    vec2 r = vec2(hash(inSeed + tSeed), hash(inSeed.yx + tSeed + 0.37));
    vec4 fr = texture(flowTexture, r);
    if (fr.a < 0.5) { r = fract(r + vec2(0.618034, 0.381966)); fr = texture(flowTexture, r); }
    if (fr.a < 0.5) { r = fract(r + vec2(0.618034, 0.381966)); fr = texture(flowTexture, r); }
    // Randomized respawn age -- no synchronized reset pulse. If all retries
    // landed outside the mask, hide (z = -1) and expire again next step.
    float spawnAge = hash(r + inSeed) * particle.lifecycle.x * particle.lifecycle.z;
    float hidden = step(fr.a, 0.5);
    outPosition = vec4(r, mix(fr.b, -1.0, hidden), mix(spawnAge, particle.lifecycle.x, hidden));
  } else {
    outPosition = vec4(newUv, h, age);
  }
}
