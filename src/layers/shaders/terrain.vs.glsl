#version 300 es
#define SHADER_NAME contour-terrain-vertex

// Grid vertices in LNGLAT; z is displaced from the baked height in the shader.
in vec3 positions;
in vec3 positions64Low;

// Per-vertex heightmap value: -1 = masked (outside Seoul / river), else [0,1].
// Baked as an attribute (not a texture) so no vertex texture fetch is needed —
// mobile GPUs often can't sample float textures in the vertex stage.
in float heightVal;

// Per-vertex slope factor: |∇h| normalized to the field mean (~1.0 at a typical
// slope). Baked on the CPU in buildGridMesh; used by the fragment shader to keep
// contour lines a uniform screen-space thickness regardless of local slope.
in float slopeVal;

out float vHeight;
out float vMask;
out float vSlope;

void main(void) {
  vMask = step(0.0, heightVal);
  vHeight = max(heightVal, 0.0);
  vSlope = slopeVal;

  geometry.worldPosition = positions;
  geometry.uv = vec2(0.0);

  // z of the position is altitude in meters for the LNGLAT coordinate system.
  vec3 pos = vec3(positions.xy, vHeight * terrain.heightScale);
  gl_Position = project_position_to_clipspace(pos, positions64Low, vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
}
