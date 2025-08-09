import React, { useRef, useState, useEffect } from "react";

export default function VideoEffectsEditor() {
  const inputRef = useRef(null);
  const originalVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const animationFrameRef = useRef(null);
  const prevSrcRef = useRef(null);

  const [src, setSrc] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [useWebGL, setUseWebGL] = useState(true);

  // Basic effect state
  const [brightness, setBrightness] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [saturation, setSaturation] = useState(1);
  const [hue, setHue] = useState(0);
  const [sepia, setSepia] = useState(0);

  // Advanced
  const [vignette, setVignette] = useState(0);
  const [grain, setGrain] = useState(0);
  const [chromatic, setChromatic] = useState(0);

  // Controls
  const [playbackRate, setPlaybackRate] = useState(1);
  const [recording, setRecording] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPreviewUrl, setExportPreviewUrl] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  // Performance controls
  const isVisibleRef = useRef(true);
  const lastFrameTimeRef = useRef(0);
  const targetFPS = 30; // throttle to 30 FPS for heavy videos/effects

  // Keep track of object URL for cleanup
  useEffect(() => {
    return () => {
      // cleanup on unmount
      if (prevSrcRef.current) {
        URL.revokeObjectURL(prevSrcRef.current);
      }
      if (exportPreviewUrl) {
        URL.revokeObjectURL(exportPreviewUrl);
      }
    };
  }, []); // eslint-disable-line

  // Handle uploaded file
  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      // revoke previous if any
      if (prevSrcRef.current) URL.revokeObjectURL(prevSrcRef.current);
      prevSrcRef.current = url;
      setSrc(url);
      setMessage(null);
      setError(null);
    } catch (err) {
      console.error(err);
      setError("Failed to load file. Try a different file or refresh the page.");
    }
  }

  // Play/pause
  function togglePlay() {
    const v = originalVideoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch((e) => console.warn("Playback prevented:", e));
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }

  // Recording & export
  async function startRecording() {
    const canvas = canvasRef.current;
    if (!canvas) return setError("No canvas available for recording.");

    try {
      recordedChunksRef.current = [];
      const stream = canvas.captureStream(targetFPS);
      const options = { mimeType: "video/webm;codecs=vp9" };
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedChunksRef.current.push(e.data);
      };

      recorder.onerror = (ev) => {
        console.error("MediaRecorder error", ev);
        setError("Recording error occurred.");
      };

      recorder.onstart = () => {
        setRecording(true);
        setExporting(true);
        setMessage("Recording started...");
      };

      recorder.onstop = () => {
        setRecording(false);
        setExporting(false);
        setMessage("Export complete — preparing preview...");
        const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        // cleanup previous export url
        if (exportPreviewUrl) URL.revokeObjectURL(exportPreviewUrl);
        setExportPreviewUrl(url);
        setTimeout(() => setMessage("Export ready — play preview or download."), 400);
      };

      recorder.start();
    } catch (err) {
      console.error(err);
      setError("Failed to start recording. Your browser may not support MediaRecorder with the chosen settings.");
      setExporting(false);
    }
  }

  function stopRecording() {
    const r = mediaRecorderRef.current;
    if (r && r.state !== "inactive") r.stop();
  }

  function downloadExport() {
    if (!exportPreviewUrl) return setError("No exported file available to download.");
    const a = document.createElement("a");
    a.href = exportPreviewUrl;
    a.download = "processed-video.webm";
    a.click();
    setMessage("Download started.");
  }

  // Visibility handling for performance
  useEffect(() => {
    function handleVisibility() {
      isVisibleRef.current = !document.hidden;
      // pause video to save CPU when not visible
      const v = originalVideoRef.current;
      if (!isVisibleRef.current && v && !v.paused) {
        v.pause();
        setPlaying(false);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Main rendering loop: WebGL or 2D with throttling and error handling
  useEffect(() => {
    let gl = null;
    let program = null;
    let positionBuffer = null;
    let tex = null;

    const video = originalVideoRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx2d = canvas.getContext("2d");

    function initWebGLSafe() {
      try {
        gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (!gl) throw new Error("WebGL not supported");
        return true;
      } catch (err) {
        console.warn("WebGL init failed:", err);
        setError("WebGL not supported by your browser — falling back to 2D rendering.");
        setUseWebGL(false);
        return false;
      }
    }

    // Small helper: compile & link shaders (kept inline for single-file convenience)
    function createProgram(gl, vsSource, fsSource) {
      function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          const msg = gl.getShaderInfoLog(s);
          gl.deleteShader(s);
          throw new Error(msg);
        }
        return s;
      }

      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog));
      }
      return prog;
    }

    // Simple vertex shader
    const vsSource = `attribute vec2 a_position;attribute vec2 a_texcoord;varying vec2 v_texcoord;void main(){v_texcoord=a_texcoord;gl_Position=vec4(a_position,0.0,1.0);}`;

    // Fragment shader (same as before but compact)
    const fsSource = `precision mediump float;varying vec2 v_texcoord;uniform sampler2D u_texture;uniform float u_brightness;uniform float u_contrast;uniform float u_saturation;uniform float u_hue;uniform float u_sepia;uniform float u_vignette;uniform float u_grain;uniform float u_chromatic;uniform float u_time;vec3 rgb2hsv(vec3 c){vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);float e=1e-10;return vec3(abs(q.z+(q.w-q.y)/(6.0*d+e)),d/(q.x+e),q.x);}vec3 hsv2rgb(vec3 c){vec3 p=abs(fract(c.x+vec3(0.0,1.0/3.0,2.0/3.0))*6.0-3.0);return c.z*mix(vec3(1.0),clamp(p-1.0,0.0,1.0),c.y);}void main(){vec2 uv=v_texcoord;vec4 color=texture2D(u_texture,uv);vec3 c=color.rgb;c*=u_brightness;c=((c-0.5)*max(u_contrast,0.0))+0.5;vec3 hsv=rgb2hsv(c);hsv.y*=u_saturation;c=hsv2rgb(hsv);hsv=rgb2hsv(c);hsv.x+=u_hue/360.0;c=hsv2rgb(hsv);vec3 sepiaColor=vec3(dot(c,vec3(0.393,0.769,0.189)),dot(c,vec3(0.349,0.686,0.168)),dot(c,vec3(0.272,0.534,0.131)));c=mix(c,sepiaColor,u_sepia);if(u_vignette>0.0){float dist=distance(uv,vec2(0.5));float vig=smoothstep(0.8,0.2,dist);c*=mix(1.0,vig,u_vignette);}if(u_grain>0.0){float n=fract(sin(dot(uv*u_time,vec2(12.9898,78.233)))*43758.5453);c+=(n-0.5)*0.25*u_grain;}if(u_chromatic>0.0){float off=0.003*u_chromatic;float r=texture2D(u_texture,uv+vec2(off,0)).r;float g=texture2D(u_texture,uv).g;float b=texture2D(u_texture,uv-vec2(off,0)).b;c=vec3(r,g,b);}gl_FragColor=vec4(clamp(c,0.0,1.0),color.a);}`;

    function setupGL() {
      if (!initWebGLSafe()) return null;
      try {
        program = createProgram(gl, vsSource, fsSource);
      } catch (err) {
        console.error("Shader compile/link error:", err);
        setError("Failed to initialize WebGL shaders. Falling back to 2D.");
        setUseWebGL(false);
        return null;
      }

      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const data = new Float32Array([-1,-1,0,0,1,-1,1,0,-1,1,0,1,-1,1,0,1,1,1,1,1]);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

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
      if (video && video.videoWidth) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        }
      }

      gl.bindTexture(gl.TEXTURE_2D, tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) {}

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const aPos = gl.getAttribLocation(program, "a_position");
      const aTex = gl.getAttribLocation(program, "a_texcoord");
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

      const setFloat = (name, val) => { const loc = gl.getUniformLocation(program, name); if (loc) gl.uniform1f(loc, val); };
      setFloat("u_brightness", brightness);
      setFloat("u_contrast", contrast);
      setFloat("u_saturation", saturation);
      setFloat("u_hue", hue);
      setFloat("u_sepia", sepia);
      setFloat("u_vignette", vignette);
      setFloat("u_grain", grain);
      setFloat("u_chromatic", chromatic);
      setFloat("u_time", time * 0.001);
      const texLoc = gl.getUniformLocation(program, "u_texture");
      gl.uniform1i(texLoc, 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function draw2D() {
      if (!video || video.readyState < 2) return;
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      // Apply CSS filter string for fast basic effects
      const filterStr = `brightness(${brightness}) contrast(${contrast}) saturate(${saturation}) hue-rotate(${hue}deg) sepia(${sepia})`;
      canvas.style.filter = filterStr;
      ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Pixel-level advanced effects (grain/vignette/chromatic) only when requested and when not cross-origin
      if (grain > 0 || vignette > 0 || chromatic > 0) {
        try {
          const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
          const data = img.data;
          const w = canvas.width;
          const h = canvas.height;
          if (grain > 0) {
            for (let i = 0; i < data.length; i += 4) {
              const n = (Math.random() - 0.5) * 255 * 0.12 * grain;
              data[i] = Math.min(255, Math.max(0, data[i] + n));
              data[i+1] = Math.min(255, Math.max(0, data[i+1] + n));
              data[i+2] = Math.min(255, Math.max(0, data[i+2] + n));
            }
          }
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
          // getImageData may fail if canvas is tainted (cross-origin). Show non-fatal warning once.
          if (!error) setError("Pixel-level effects disabled due to cross-origin tainting of the video.");
        }
      }
    }

    function smoothstep(a, b, x) {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    // Initialize GL if requested
    if (useWebGL) {
      try {
        const ok = setupGL();
        if (!ok) {
          // setupGL already handled fallback
        }
      } catch (err) {
        console.error(err);
      }
    }

    function frame(time) {
      // throttle by targetFPS
      const last = lastFrameTimeRef.current || 0;
      const minDelta = 1000 / targetFPS;
      if (!isVisibleRef.current) {
        // skip rendering when not visible; leave requestAnimationFrame to keep loop alive but cheap
        lastFrameTimeRef.current = time;
        animationFrameRef.current = requestAnimationFrame(frame);
        return;
      }
      if (time - last < minDelta) {
        animationFrameRef.current = requestAnimationFrame(frame);
        return;
      }
      lastFrameTimeRef.current = time;

      if (useWebGL && program && gl) {
        drawWebGL(time);
      } else {
        draw2D();
      }
      animationFrameRef.current = requestAnimationFrame(frame);
    }

    animationFrameRef.current = requestAnimationFrame(frame);

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      // free GL resources if present
      try {
        if (gl) {
          if (tex) gl.deleteTexture(tex);
          if (positionBuffer) gl.deleteBuffer(positionBuffer);
          if (program) gl.deleteProgram(program);
        }
      } catch (e) {}
    };
  }, [useWebGL, brightness, contrast, saturation, hue, sepia, vignette, grain, chromatic]);

  // When video source changes, set playbackRate and attach play/pause listeners
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
      <h1 className="text-2xl font-semibold mb-3">🎞️ Video Effects — Optimized Editor</h1>

      {/* Error / Message banners */}
      {error && (
        <div role="alert" aria-live="assertive" className="mb-4 p-3 rounded bg-red-100 text-red-800">
          <strong>Error:</strong> {error}
        </div>
      )}
      {message && (
        <div role="status" aria-live="polite" className="mb-4 p-3 rounded bg-blue-50 text-blue-800">
          {message}
        </div>
      )}

      <div className="mb-4 flex gap-3 items-center">
        <label className="flex items-center gap-2" htmlFor="fileInput">
          <input
            id="fileInput"
            ref={inputRef}
            type="file"
            accept="video/*"
            onChange={handleFile}
            aria-label="Upload a video file"
            className=""
          />
        </label>

        <button onClick={() => setUseWebGL((s) => !s)} aria-pressed={useWebGL} aria-label="Toggle WebGL shaders" className="px-3 py-1 border rounded">
          {useWebGL ? "WebGL Shaders: ON" : "WebGL Shaders: OFF"}
        </button>

        <button onClick={() => { const v = originalVideoRef.current; if (v) { v.currentTime = 0; } }} aria-label="Restart video" className="px-3 py-1 border rounded">Restart</button>

        <div className="ml-auto flex gap-2">
          {!recording && <button onClick={startRecording} aria-label="Start export" className="px-3 py-1 bg-green-600 text-white rounded">Start Export</button>}
          {recording && <button onClick={stopRecording} aria-label="Stop export" className="px-3 py-1 bg-red-600 text-white rounded">Stop Export</button>}
        </div>
      </div>

      {/* Side-by-side preview */}
      <div className="grid grid-cols-2 gap-4">
        <div className="border p-2 rounded">
          <div className="mb-2 font-medium">Original</div>
          <video
            ref={originalVideoRef}
            src={src}
            controls
            className="w-full max-h-[480px] bg-black"
            crossOrigin="anonymous"
            aria-label="Original video preview"
          />
        </div>

        <div className="border p-2 rounded relative">
          <div className="mb-2 font-medium">Processed</div>
          <div className="w-full bg-black flex items-center justify-center">
            <canvas ref={canvasRef} className="w-full max-h-[480px]" role="img" aria-label="Processed video preview canvas" />
          </div>

          {/* Export spinner / progress overlay */}
          {exporting && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <div role="status" aria-live="polite" className="p-3 rounded bg-white/90 text-black flex items-center gap-3">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" strokeLinecap="round" />
                </svg>
                <span>Exporting — please wait...</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="mt-6 grid grid-cols-2 gap-6">
        <div className="border p-4 rounded">
          <h3 className="font-semibold mb-2">Basic Controls</h3>

          <label className="block mb-2">Brightness: {brightness.toFixed(2)}</label>
          <input aria-label="Adjust brightness" type="range" min="0" max="2" step="0.01" value={brightness} onChange={(e) => setBrightness(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Contrast: {contrast.toFixed(2)}</label>
          <input aria-label="Adjust contrast" type="range" min="0" max="3" step="0.01" value={contrast} onChange={(e) => setContrast(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Saturation: {saturation.toFixed(2)}</label>
          <input aria-label="Adjust saturation" type="range" min="0" max="3" step="0.01" value={saturation} onChange={(e) => setSaturation(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Hue: {Math.round(hue)}°</label>
          <input aria-label="Adjust hue" type="range" min="-180" max="180" step="1" value={hue} onChange={(e) => setHue(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Sepia: {sepia.toFixed(2)}</label>
          <input aria-label="Adjust sepia" type="range" min="0" max="1" step="0.01" value={sepia} onChange={(e) => setSepia(parseFloat(e.target.value))} />
        </div>

        <div className="border p-4 rounded">
          <h3 className="font-semibold mb-2">Advanced Controls</h3>

          <label className="block mb-2">Vignette: {vignette.toFixed(2)}</label>
          <input aria-label="Adjust vignette" type="range" min="0" max="1" step="0.01" value={vignette} onChange={(e) => setVignette(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Film Grain: {grain.toFixed(2)}</label>
          <input aria-label="Adjust grain" type="range" min="0" max="1" step="0.01" value={grain} onChange={(e) => setGrain(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Chromatic Aberration: {chromatic.toFixed(2)}</label>
          <input aria-label="Adjust chromatic aberration" type="range" min="0" max="1" step="0.01" value={chromatic} onChange={(e) => setChromatic(parseFloat(e.target.value))} />

          <label className="block mt-3 mb-2">Playback Rate: {playbackRate}x</label>
          <input aria-label="Adjust playback rate" type="range" min="0.25" max="2" step="0.05" value={playbackRate} onChange={(e) => { setPlaybackRate(parseFloat(e.target.value)); if (originalVideoRef.current) originalVideoRef.current.playbackRate = parseFloat(e.target.value); }} />
        </div>
      </div>

      {/* Export preview / actions */}
      <div className="mt-6 flex gap-3 items-center">
        {exportPreviewUrl && (
          <div className="flex items-center gap-3">
            <div className="text-sm">Export Preview:</div>
            <video key={exportPreviewUrl} src={exportPreviewUrl} controls className="h-28" aria-label="Exported video preview" />
            <button onClick={downloadExport} className="px-3 py-1 border rounded" aria-label="Download exported video">Download</button>
          </div>
        )}

        <div className="ml-auto text-sm text-gray-600">Tip: Large videos may use more memory — revoke object URLs when no longer needed.</div>
      </div>

      {/* Footer notes */}
      <div className="mt-6 text-sm text-gray-600">
        <p><strong>Notes:</strong></p>
        <ul className="list-disc ml-6">
          <li>Accessibility: controls include ARIA attributes for better screen-reader support.</li>
          <li>Performance: rendering pauses when the tab is hidden and rendering is throttled to {targetFPS} FPS.</li>
          <li>UI: export shows a spinner and playback preview when complete.</li>
          <li>Error handling surfaces messages to the user; check console for more details.</li>
          <li>Code Splitting: see the commented section below for how to split shaders and helpers into <code>shaders.js</code> and <code>utils.js</code>.</li>
        </ul>
      </div>

      {/* Short accessibility helper: keyboard hint */}
      <div className="mt-3 text-xs text-gray-500">Keyboard: use Tab to navigate controls. All important controls have ARIA labels.</div>
    </div>
  );
}
