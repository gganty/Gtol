/**
 * Stores shader source code (GPU programs).
 * Language: GLSL (OpenGL Shading Language).
 * Exports vertex and fragment shaders for Points and Lines.
 */

// VERTEX SHADER
// Runs once per point.
// Goal: Transform (x, y) coordinates to screen coordinates (-1.0 ... +1.0).
export const POINT_VS = `
  attribute vec2 a_position; // Input: X, Y of point (from buffer)
  attribute float a_size;    // Input: Size
  attribute vec3 a_color;    // Input: Color (R, G, B)
  
  uniform vec2 u_resolution; // Global variable: Screen Width/Height
  uniform vec3 u_transform;  // Global variable: Pan X, Pan Y, Zoom Scale
  uniform float u_is_circular; // Flag: circular sizing behavior
  uniform float u_node_scale;  // Global Node UI Size Scale factor
  
  varying vec3 v_color;      // Output: Pass color to fragment shader
  
  void main() {
    float final_size = a_size * u_node_scale;
    if (u_is_circular > 0.5) {
        final_size *= 0.25; // Reduce sizes heavily inside circular layouts
    }
  
    // 1. Apply Zoom and Pan (Matrix transformations manually)
    // Formula: (pos + translate) * scale
    vec2 pos = (a_position + u_transform.xy) * u_transform.z;
    
    // 2. Normalize to Clip Space (-1..1)
    // (pos / resolution) * 2.0 - 1.0
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    
    gl_Position = vec4(clip, 0.0, 1.0);
    
    // gl_PointSize - built-in WebGL variable for point size
    // max(..., 2.0) ensures point doesn't disappear completely
    gl_PointSize = max(final_size * u_transform.z, 2.0);
    
    v_color = a_color;
  }
`;

// --- FRAGMENT SHADER ---
// Runs for every PIXEL inside square point.
// Goal: Draw a circle inside the square (discard corners).
export const POINT_FS = `
  precision mediump float; // Calculation precision
  varying vec3 v_color;    // Color received from Vertex Shader
  uniform int u_is_line;   // Flag: drawing line or point?
  
  void main() {
    if (u_is_line == 1) {
        // If it's a link line - draw just red/gray pixel
        // (For lines transparency is lower - 0.25)
        gl_FragColor = vec4(0.8, 0.8, 0.8, 0.5); 
        return;
    }
  
    // CIRCLE DRAWING (SDF - Signed Distance Field)
    // gl_PointCoord - coordinates inside point from 0.0 to 1.0
    // Convert them to -1.0 ... +1.0 range
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    
    // Calculate distance from center (r^2 = x^2 + y^2)
    float r = dot(cxy, cxy);
    
    // If pixel is outside radius 1.0 - discard it (transparency)
    if (r > 1.0) discard;
    
    // Edge smoothing (Antialiasing)
    float alpha = 1.0 - smoothstep(0.95, 1.0, r);
    
    // Final pixel color
    gl_FragColor = vec4(v_color, alpha * 0.95); 
  }
`;

// Line shader
export const LINE_VS = `
  attribute float a_t;          // Base geometry (0.0 to 1.0)
  attribute vec4 a_link_coords; // Instance data: [orig_x1, orig_y1, orig_x2, orig_y2]
  
  uniform vec2 u_resolution;
  uniform vec3 u_transform;
  uniform float u_is_circular;

  // Uniforms for polar transform parameters
  uniform float u_hole_radius; 
  uniform float u_scale_x;
  uniform float u_max_y;

  void main() {
    float t = a_t;
    
    vec2 start = a_link_coords.xy;
    vec2 end = a_link_coords.zw;

    vec2 local_pos;

    if (u_is_circular > 0.5) {
        // Interpolate normalized original coordinates
        vec2 curr_orig = mix(start, end, t);

        // Apply polar transform (curr_orig.y is already normalized 0..1 in buffer)
        float r = u_hole_radius + (curr_orig.x * u_scale_x);
        float theta = curr_orig.y * 2.0 * 3.14159265359 - 1.57079632679;
        
        local_pos = vec2(r * cos(theta), r * sin(theta));
    } else {
        // Linear interpolation in chunk-relative Cartesian space
        local_pos = mix(start, end, t);
    }

    vec2 pos = (local_pos + u_transform.xy) * u_transform.z;
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    gl_Position = vec4(clip, 0.0, 1.0);
  }
`;

export const LINE_FS = `
  precision mediump float;
void main() {
  // Draw lines with semi-transparent white
  gl_FragColor = vec4(1.0, 1.0, 1.0, 0.25); 
}
`;