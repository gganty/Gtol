/**
 * shaders.js
 * Хранит исходный код шейдеров (программ для GPU).
 * Язык: GLSL (OpenGL Shading Language).
 */

// --- ВЕРШИННЫЙ ШЕЙДЕР (Vertex Shader) ---
// Запускается 1 раз для каждой точки.
// Задача: Превратить координаты (x, y) в экранные координаты (-1.0 ... +1.0).
export const POINT_VS = `
  attribute vec2 a_position; // Вход: X, Y точки (из буфера)
  attribute float a_size;    // Вход: Размер
  attribute vec3 a_color;    // Вход: Цвет (R, G, B)
  
  uniform vec2 u_resolution; // Глобальная переменная: Ширина/Высота экрана
  uniform vec3 u_transform;  // Глобальная переменная: Pan X, Pan Y, Zoom Scale
  
  varying vec3 v_color;      // Выход: Передаем цвет дальше в пиксельный шейдер
  
  void main() {
    // 1. Применяем Zoom и Pan (Матричные трансформации вручную)
    // Формула: (pos + translate) * scale
    vec2 pos = (a_position + u_transform.xy) * u_transform.z;
    
    // 2. Нормализация в Clip Space (-1..1)
    // (pos / resolution) * 2.0 - 1.0
    vec2 clip = (pos / u_resolution) * 2.0 - 1.0;
    
    // 3. Результат
    gl_Position = vec4(clip, 0.0, 1.0);
    
    // gl_PointSize - встроенная переменная WebGL для размера точки
    // max(..., 2.0) гарантирует, что точка не исчезнет совсем
    gl_PointSize = max(a_size * u_transform.z, 2.0);
    
    v_color = a_color;
  }
`;

// --- ФРАГМЕНТНЫЙ ШЕЙДЕР (Fragment Shader) ---
// Запускается для каждого ПИКСЕЛЯ внутри квадратной точки.
// Задача: Нарисовать круг внутри квадрата (обрезка углов).
export const POINT_FS = `
  precision mediump float; // Точность вычислений
  varying vec3 v_color;    // Цвет, пришедший из Vertex Shader
  uniform int u_is_line;   // Флаг: рисуем линию или точку?
  
  void main() {
    if (u_is_line == 1) {
        // Если это линия связи - рисуем просто красный/серый пиксель
        // (Для линий прозрачность ниже - 0.25)
        gl_FragColor = vec4(0.8, 0.8, 0.8, 0.5); 
        return;
    }
  
    // РИСОВАНИЕ КРУГА (SDF - Signed Distance Field)
    // gl_PointCoord - координаты внутри точки от 0.0 до 1.0
    // Превращаем их в диапазон -1.0 ... +1.0
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    
    // Считаем расстояние от центра (r^2 = x^2 + y^2)
    float r = dot(cxy, cxy);
    
    // Если пиксель дальше радиуса 1.0 - выбрасываем его (прозрачность)
    if (r > 1.0) discard;
    
    // Сглаживание краев (Antialiasing)
    float alpha = 1.0 - smoothstep(0.95, 1.0, r);
    
    // Итоговый цвет пикселя
    gl_FragColor = vec4(v_color, alpha * 0.95); 
  }
`;

// --- ШЕЙДЕРЫ ДЛЯ ЛИНИЙ (Простые) ---
export const LINE_VS = `
  attribute vec2 a_position;
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
  // Линии рисуем полупрозрачным белым
  gl_FragColor = vec4(1.0, 1.0, 1.0, 0.25); 
}
`;