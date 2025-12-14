export const POINT_VS = `
  attribute vec2 a_position;
  attribute float a_size;
  attribute vec3 a_color;
  
  uniform vec2 u_resolution;
  uniform vec3 u_transform; // x, y, k (scale)
  
  varying vec3 v_color;
  
  void main() {
    vec2 pos = (a_position + u_transform.xy) * u_transform.z;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    
    gl_Position = vec4(clip, 0.0, 1.0);
    gl_PointSize = max(a_size * u_transform.z, 2.0);
    v_color = a_color;
  }
`;

export const POINT_FS = `
  precision mediump float;
  varying vec3 v_color;
  uniform int u_is_line; // 1 = Line, 0 = Point
  
  void main() {
    if (u_is_line == 1) {
        // Line Shader: FORCE RED
        gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); 
        return;
    }
  
    // Point Shader: Circles
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    float r = dot(cxy, cxy);
    if (r > 1.0) discard;
    
    float alpha = 1.0 - smoothstep(0.95, 1.0, r);
    gl_FragColor = vec4(v_color, alpha * 0.95); // Higher base alpha
  }
`;

// --- LINE EMULATION ---
export const LINE_VS = `
  attribute vec2 a_position;
  // No size/color attributes needed if we force them
  
  uniform vec2 u_resolution;
  uniform vec3 u_transform;

void main() {
    vec2 pos = (a_position + u_transform.xy) * u_transform.z;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

export const LINE_FS = `
  precision mediump float;
void main() {
  gl_FragColor = vec4(1.0, 1.0, 1.0, 0.25); // White, 40% Opacity
}
`;

