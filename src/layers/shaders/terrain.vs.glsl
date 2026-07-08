#version 300 es
#define SHADER_NAME contour-terrain-vertex

// Grid vertices in LNGLAT; z is displaced from the heightmap in the shader.
in vec3 positions;
in vec3 positions64Low;
in vec2 texCoords;

// Heightmap texel value: -1 = masked (outside Seoul / river), else [0,1].
uniform sampler2D uHeightmap;

out float vHeight;
out float vMask;

void main(void) {
  float h = texture(uHeightmap, texCoords).r;
  vMask = step(0.0, h);
  vHeight = max(h, 0.0);

  geometry.worldPosition = positions;
  geometry.uv = texCoords;

  // z of the position is altitude in meters for the LNGLAT coordinate system.
  vec3 pos = vec3(positions.xy, vHeight * terrain.heightScale);
  gl_Position = project_position_to_clipspace(pos, positions64Low, vec3(0.0), geometry.position);
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);

  vec4 color = vec4(0.0);
  DECKGL_FILTER_COLOR(color, geometry);
}
