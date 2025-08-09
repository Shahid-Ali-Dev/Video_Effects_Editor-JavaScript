import React, { useRef, useState, useEffect } from "react";

// VideoEffectsEditor.jsx
// Single-file React component (Tailwind ready) that allows uploading a video,
// previewing the original on the left and a processed (real-time) version on the right.
// Processing uses either CSS filters (fast) or a WebGL fragment shader (advanced).
// Includes controls for basic and advanced effects and the ability to export the
// processed canvas to a downloadable video (via MediaRecorder).

// NOTE: This file assumes a React + Tailwind environment. If you're using Next.js/CRA,
// drop this component into your app and render <VideoEffectsEditor />.

export default function VideoEffectsEditor() {
  const inputRef = useRef(null);
  const originalVideoRef = useRef(null);
  const processedCanvasRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const animationFrameRef = useRef(null);

  const [src, setSrc] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [useWebGL, setUseWebGL] = useState(false);

  // Basic effect state (0.. values chosen for UI friendliness)
  const [brightness, setBrightness] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [hue, setHue] = useState(0); // degrees
  const [sepia, setSepia] = useState(0);

  // Advanced effects
  const [vignette, setVignette] = useState(0);
  const [grain, setGrain] = useState(0);
  const [chromatic, setChromatic] = useState(0);

  // Playback speed
  const [playbackRate, setPlaybackRate] = useState(1);

  // Recording state
  const [recording, setRecording] = useState(false);

  // Set uploaded file as source
  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    // reset
    setPlaying(false);
  }

  function togglePlay() {
    const v = originalVideoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  // Export processed canvas to video file
  function startRecording() {
    const canvas = processedCanvasRef.current;
    if (!canvas) return;
    recordedChunksRef.current = [];
    const stream = canvas.captureStream(30); // 30fps
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordedChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "processed-video.webm";
      a.click();
      URL.revokeObjectURL(url);
    };
    mediaRecorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    const r = mediaRecorderRef.current;
    if (r && r.state !== "inactive") r.stop();
    setRecording(false);
  }

  // Apply processing loop: draw video to canvas and apply effects.
  useEffect(() => {
    let gl = null;
    let program = null;
    let positionBuffer = null;
    let tex = null;

    const video = originalVideoRef.current;
    const canvas = processedCanvasRef.current;
    if (!canvas) return;

    const ctx2d = canvas.getContext("2d");

    // Utilities for WebGL shader setup
    function initWebGL() {
      gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (!gl) {
        console.warn("WebGL not supported, falling back to 2D/CSS filters.");
        setUseWebGL(false);
        return false;
      }

      // Basic passthrough vertex shader
      const vsSource = `
        attribute vec2 a_position;
        attribute vec2 a_texcoord;
        varying vec2 v_texcoord;
        void main() {
          v_texcoord = a_texcoord;
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `;

      // Fragment shader with several effect uniforms
      const fsSource = `
        precision mediump float;
        varying vec2 v_texcoord;
        uniform sampler2D u_texture;
        uniform float u_brightness;
        uniform float u_contrast;
        uniform float u_saturation;
        uniform float u_hue; // degrees
        uniform float u_sepia;
        uniform float u_vignette;
        uniform float u_grain;
        uniform float u_chromatic;
        uniform float u_time;

        // Helper functions
        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }
        vec3 hsv2rgb(vec3 c) {
          vec3 p = abs(fract(c.x + vec3(0.0, 1.0/3.0, 2.0/3.0)) * 6.0 - 3.0);
          return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
        }

        void main() {
          vec2 uv = v_texcoord;
          vec4 color = texture2D(u_texture, uv);
          vec3 c = color.rgb;

          // Brightness
          c = c * u_brightness;

          // Contrast
          c = ((c - 0.5) * max(u_contrast, 0.0)) + 0.5;

          // Saturation (convert to hsv, modify s)
          vec3 hsv = rgb2hsv(c);
          hsv.y *= u_saturation;
          c = hsv2rgb(hsv);

          // Hue rotate (in HSV space)
          hsv = rgb2hsv(c);
          hsv.x += u_hue / 360.0;
          c = hsv2rgb(hsv);

          // Sepia mix
          vec3 sepiaColor = vec3(
            dot(c, vec3(0.393, 0.769, 0.189)),
            dot(c, vec3(0.349, 0.686, 0.168)),
            dot(c, vec3(0.272, 0.534, 0.131))
          );
          c = mix(c, sepiaColor, u_sepia);

          // Vignette (distance from center darkening)
          if (u_vignette > 0.0) {
            float dist = distance(uv, vec2(0.5));
            float vig = smoothstep(0.8, 0.2, dist);
            c *= mix(1.0, vig, u_vignette);
          }

          // Grain (simple noise)
          if (u_grain > 0.0) {
            float n = fract(sin(dot(uv * u_time, vec2(12.9898,78.233))) * 43758.5453);
            c += (n - 0.5) * 0.25 * u_grain;
          }

          // Chromatic aberration (sample slightly offset channels)
          if (u_chromatic > 0.0) {
            float off = 0.003 * u_chromatic;
            float r = texture2D(u_texture, uv + vec2(off,0)).r;
            float g = texture2D(u_texture, uv).g;
            float b = texture2D(u_texture, uv - vec2(off,0)).b;
            c = vec3(r,g,b);
          }

          gl_FragColor = vec4(clamp(c, 0.0, 1.0), color.a);
        }
      `;

      function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.error("Shader compile error:", gl.getShaderInfoLog(shader));
          return null;
        }
        return shader;
      }

      const vs = compileShader(gl.VERTEX_SHADER, vsSource);
      const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program link error:", gl.getProgramInfoLog(program));
        return false;
      }

      // Setup a full-screen quad
      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      // x,y and u,v
      const data = new Float32Array([
        -1, -1, 0, 0,
         1, -1, 1, 0,
        -1,  1, 0, 1,
        -1,  1, 0, 1,
         1, -1, 1, 0,
         1,  1, 1, 1,
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

      // Create texture
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      return true;
    }

    function drawWebGL(time) {
      if (!gl || !program) return;
      // Resize canvas to match video aspect
      if (video && video.videoWidth) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }
      }

      // upload frame into texture
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch (e) {
        // texImage2D might fail if video not ready
      }

      gl.useProgram(program);

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const aPos = gl.getAttribLocation(program, "a_position");
      const aTex = gl.getAttribLocation(program, "a_texcoord");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

      // set uniforms
      const setFloat = (name, val) => {
        const loc = gl.getUniformLocation(program, name);
        if (loc) gl.uniform1f(loc, val);
      };

      setFloat("u_brightness", brightness);
      setFloat("u_contrast", contrast);
      setFloat("u_saturation", saturation);
      setFloat("u_hue", hue);
      setFloat("u_sepia", sepia);
      setFloat("u_vignette", vignette);
      setFloat("u_grain", grain);
      setFloat("u_chromatic", chromatic);
      setFloat("u_time", time * 0.001);

      // texture unit
      const texLoc = gl.getUniformLocation(program, "u_texture");
      gl.uniform1i(texLoc, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function draw2D() {
      if (!video || video.readyState < 2) return;
      // Resize canvas to match video
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // If not using WebGL, draw the video directly then apply extra effects via pixel ops (simple) or CSS filters.
      // For performance we use ctx.drawImage and apply a lightweight pixel-modification for grain & vignette.
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Pull pixels if grain/vignette enabled or if some advanced effects requested
      if (grain > 0 || vignette > 0 || chromatic > 0) {
        try {
          const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
          const data = img.data;
          const w = canvas.width;
          const h = canvas.height;
          // Grain: add small noise
          if (grain > 0) {
            for (let i = 0; i < data.length; i += 4) {
              const n = (Math.random() - 0.5) * 255 * 0.15 * grain;
              data[i] = Math.min(255, Math.max(0, data[i] + n));
              data[i+1] = Math.min(255, Math.max(0, data[i+1] + n));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + n));
            }
          }
          // Vignette: darken edges
          if (vignette > 0) {
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const dx = (x / w - 0.5);
                const dy = (y / h - 0.5);
                const dist = Math.sqrt(dx*dx + dy*dy);
                const vig = 1 - smoothstep(0.4, 0.9, dist) * vignette;
                data[idx] = data[idx] * vig;
                data[idx+1] = data[idx+1] * vig;
                data[idx+2] = data[idx+2] * vig;
              }
            }
          }

          ctx2d.putImageData(img, 0, 0);
        } catch (e) {
          // getImageData can be slow or fail on cross-origin videos; ignore and continue
        }
      }
    }

    function smoothstep(a, b, x) {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    function frame(time) {
      if (!originalVideoRef.current) return;
      if (useWebGL) {
        if (!gl) {
          const ok = initWebGL();
          if (!ok) {
            // fallback
            draw2D();
            animationFrameRef.current = requestAnimationFrame(frame);
            return;
          }
        }
        drawWebGL(time);
      } else {
        // Apply CSS filters if possible for basic adjustments (faster) then draw into canvas
        // We can simply draw the video into the canvas; for basic brightness/contrast/hue/sat/sepia
        // we apply the equivalent CSS filter string on the canvas element using style.
        const filterStr = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hue}deg) sepia(${sepia})`;
        canvas.style.filter = filterStr;
        draw2D();
      }
      animationFrameRef.current = requestAnimationFrame(frame);
    }

    // Start loop
    animationFrameRef.current = requestAnimationFrame(frame);

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [useWebGL, brightness, contrast, saturation, hue, sepia, vignette, grain, chromatic]);

  // When video source changes, reset playback rate and attach events
  useEffect(() => {
    const v = originalVideoRef.current;
    if (!v) return;
    v.playbackRate = playbackRate;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [src, playbackRate]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold mb-4">Video Effects — Real-time Editor</h1>
      <p className="mb-4 text-sm text-gray-600">Upload a video, tweak the sliders and see the original (left) and processed (right) side-by-side. Use WebGL for advanced shaders or CSS filters for a fast path.</p>

      <div className="mb-4 flex gap-3 items-center">
        <input ref={inputRef} type="file" accept="video/*" onChange={handleFile} className="" />
        <button onClick={() => setUseWebGL((s) => !s)} className="px-3 py-1 border rounded">{useWebGL ? "Use CSS Filters" : "Use WebGL Shaders"}</button>
        <button onClick={() => { const v = originalVideoRef.current; if (v) { v.currentTime = 0; } }} className="px-3 py-1 border rounded">Restart</button>
        <div className="ml-auto flex gap-2">
          {!recording && <button onClick={startRecording} className="px-3 py-1 bg-green-500 text-white rounded">Start Export</button>}
          {recording && <button onClick={stopRecording} className="px-3 py-1 bg-red-500 text-white rounded">Stop & Download</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Original */}
        <div className="border p-2 rounded">
          <div className="mb-2 font-medium">Original</div>
          <video
            ref={originalVideoRef}
            src={src}
            controls
            className="w-full max-h-[480px] bg-black"
            crossOrigin="anonymous"
          />
        </div>

        {/* Processed */}
        <div className="border p-2 rounded">
          <div className="mb-2 font-medium">Processed</div>
          <div className="w-full bg-black flex items-center justify-center">
            <canvas ref={processedCanvasRef} className="w-full max-h-[480px]" />
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6">
        <div className="border p-4 rounded">
          <h3 className="font-semibold mb-2">Basic Controls</h3>
          <label className="block mb-2">Brightness: {brightness.toFixed(2)}</label>
          <input type="range" min="0" max="2" step="0.01" value={brightness} onChange={(e) => setBrightness(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Contrast: {contrast.toFixed(2)}</label>
          <input type="range" min="0" max="3" step="0.01" value={contrast} onChange={(e) => setContrast(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Saturation: {saturation.toFixed(2)}</label>
          <input type="range" min="0" max="3" step="0.01" value={saturation} onChange={(e) => setSaturation(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Hue: {Math.round(hue)}°</label>
          <input type="range" min="-180" max="180" step="1" value={hue} onChange={(e) => setHue(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Sepia: {sepia.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.01" value={sepia} onChange={(e) => setSepia(parseFloat(e.target.value))} />
        </div>

        <div className="border p-4 rounded">
          <h3 className="font-semibold mb-2">Advanced Controls</h3>
          <label className="block mb-2">Vignette: {vignette.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.01" value={vignette} onChange={(e) => setVignette(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Film Grain: {grain.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.01" value={grain} onChange={(e) => setGrain(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Chromatic Aberration: {chromatic.toFixed(2)}</label>
          <input type="range" min="0" max="1" step="0.01" value={chromatic} onChange={(e) => setChromatic(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Playback Rate: {playbackRate}x</label>
          <input type="range" min="0.25" max="2" step="0.05" value={playbackRate} onChange={(e) => { setPlaybackRate(parseFloat(e.target.value)); if (originalVideoRef.current) originalVideoRef.current.playbackRate = parseFloat(e.target.value); }} />
        </div>
      </div>

      <div className="mt-6 text-sm text-gray-600">
        <p><strong>Notes:</strong></p>
        <ul className="list-disc ml-6">
          <li>WebGL path uses a fragment shader for more advanced and GPU-accelerated effects — enable it for best quality (and when your browser supports WebGL).</li>
          <li>CSS filter path is faster but less flexible — it applies the filters to the canvas element and uses CPU-only pixel ops for grain/vignette when needed.</li>
          <li>Export uses <code>canvas.captureStream()</code> and <code>MediaRecorder</code>. Some browsers may record different codecs; exported file is a WebM by default.</li>
          <li>If your uploaded video is cross-origin (from remote server) the canvas may become tainted and pixel-level operations will be blocked. Local uploads (from your disk) will work fine.</li>
        </ul>
      </div>
    </div>
  );
}