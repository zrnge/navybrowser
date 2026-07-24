// canvas-hook.js — MAIN-world content script, injected before the page runs.
//
// Problem: HTML5 canvas is a pixel sink. The browser DOM has no knowledge of
// what JavaScript draws inside a <canvas>, so Navy's SOM system (which is DOM-
// based) produces exactly ONE entry for any canvas element. Everything the game
// or app draws inside it is invisible to the tooling, forcing the LLM to visually
// estimate click coordinates from a screenshot — imprecise and fragile.
//
// Fix: intercept CanvasRenderingContext2D.prototype.fillText / strokeText before
// the page JavaScript runs. Every text draw call is captured together with the
// current 2D transform matrix, stored with a short TTL, and exposed via
// window.__navy_canvas_elements() for background.js to query via CDP.
// background.js injects those entries into the SOM element map as "canvas-text"
// elements rendered as GREEN labeled boxes on the screenshot — letting the LLM
// click canvas content by som_id (exact coordinates) rather than by visual guess.
//
// Coverage: 2D canvas text AND drawImage sprite rects (kind:"img" entries) —
// HTML5 games, canvas UIs, board/card games, sprite-sheet buttons.
// Also covers MAIN-THREAD OffscreenCanvas: pages that call
// canvas.transferControlToOffscreen() and then draw on the offscreen context from
// the main thread (double-buffering libraries) are mapped back to their visible
// <canvas> so their text still becomes clickable SOM elements.
// Does NOT cover: WebGL (different rendering pipeline), VNC putImageData (raw
// pixel pushes with no semantic content), or OffscreenCanvas drawn inside a Web
// Worker (a separate JS realm the content script cannot patch). For those,
// zoom_canvas + visual estimation remains the fallback.
//
// Coordinate fix: canvas.width / canvas.height are the logical drawing surface
// dimensions in canvas pixels. The canvas element's CSS size
// (getBoundingClientRect().width/height) is the visual size in CSS pixels.
// These differ when the canvas is rendered at a higher resolution than its CSS
// size (HiDPI/retina canvases, scaled game canvases, etc.).  All stored
// coordinates are converted to CSS pixels at record time so background.js can
// use them directly for CDP clicks without any further scaling.

(function () {
  if (window.__navy_canvas_hook_installed) return;
  window.__navy_canvas_hook_installed = true;

  // WeakMap from canvas element → Map<dedup-key, entry>
  // WeakMap lets the GC collect canvas elements that leave the DOM.
  const store = new WeakMap();

  function getMap(canvas) {
    if (!store.has(canvas)) store.set(canvas, new Map());
    return store.get(canvas);
  }

  // Maps an OffscreenCanvas back to the visible <canvas> it was transferred from,
  // so text drawn on the offscreen surface can be positioned and stored under a
  // real on-screen element. Captured when transferControlToOffscreen() is called.
  const offscreenToVisible = new WeakMap();

  const hasOffscreen = typeof OffscreenCanvas !== "undefined";

  // Resolve a drawing surface (visible <canvas> or OffscreenCanvas) to the visible
  // <canvas> that displays it. Returns null for an OffscreenCanvas with no known
  // on-screen home (e.g. one only ever blitted via drawImage) — such text cannot
  // be localized and is skipped.
  function resolveVisibleCanvas(surface) {
    if (surface instanceof HTMLCanvasElement) return surface;
    if (hasOffscreen && surface instanceof OffscreenCanvas) {
      return offscreenToVisible.get(surface) || null;
    }
    return null;
  }

  function parseFontPx(font) {
    const m = (font || "").match(/(\d+(?:\.\d+)?)\s*px/);
    return m ? parseFloat(m[1]) : 12;
  }

  // Per-canvas rect cache — getBoundingClientRect() is called at most once per
  // RECT_CACHE_MS per canvas so animation loops that call fillText hundreds of
  // times per frame don't hammer layout.
  const _rectCache = new WeakMap();
  const RECT_CACHE_MS = 50;

  function getCanvasRect(canvas) {
    const cached = _rectCache.get(canvas);
    if (cached && (Date.now() - cached.ts) < RECT_CACHE_MS) return cached;
    let r;
    try { r = canvas.getBoundingClientRect(); } catch (_) { r = { left: 0, top: 0, width: 0, height: 0 }; }
    const entry = {
      left: Math.round(r.left),
      top:  Math.round(r.top),
      cssW: r.width,    // CSS pixel width of the canvas element
      cssH: r.height,   // CSS pixel height of the canvas element
      ts:   Date.now(),
    };
    _rectCache.set(canvas, entry);
    return entry;
  }

  // Core recorder: called from the fillText / strokeText wrappers with the
  // drawing context, the string, and the pre-transform (local) coordinates.
  // Applies the current 2D affine transform to get canvas-relative position,
  // then converts from canvas pixel space to CSS pixel space using the ratio
  // cssSize/canvasInternalSize, and stores the entry.
  function record(ctx, text, localX, localY) {
    if (!text) return;
    const trimmed = String(text).trim();
    if (!trimmed) return;

    // surface = the drawing surface (visible <canvas> OR OffscreenCanvas); both
    // expose width/height (the drawing-surface resolution). canvas = the visible
    // element used for on-screen positioning and as the store key.
    const surface = ctx.canvas;
    if (!surface || surface.width < 4 || surface.height < 4) return;
    const canvas = resolveVisibleCanvas(surface);
    if (!canvas) return; // OffscreenCanvas with no on-screen home — can't localize.

    // Apply the current transform matrix to convert from local to canvas-local coords.
    // DOMMatrix: [a c e]   [x]   [ax + cy + e]
    //            [b d f] × [y] = [bx + dy + f]
    let canvasPxX = localX, canvasPxY = localY;
    try {
      const t = ctx.getTransform();
      canvasPxX = t.a * localX + t.c * localY + t.e;
      canvasPxY = t.b * localX + t.d * localY + t.f;
    } catch (_) { /* getTransform unavailable — use coords as-is */ }

    // Cache the canvas CSS rect at draw time (same synchronous frame as fillText)
    // so that canvas position drift from scroll/animation is eliminated.
    const rect = getCanvasRect(canvas);

    // Canvas-to-CSS scale: canvas.width is the drawing surface resolution;
    // rect.cssW is the visual (CSS pixel) width. One canvas pixel = scaleX CSS px.
    // When these match (scale = 1), no correction is needed.
    // When the canvas is rendered at 2× (HiDPI), scaleX = 0.5.
    const scaleX = (rect.cssW > 0 && surface.width  > 0) ? rect.cssW / surface.width  : 1;
    const scaleY = (rect.cssH > 0 && surface.height > 0) ? rect.cssH / surface.height : 1;

    // Convert canvas-pixel coordinates → CSS-pixel offset within the canvas element.
    const cssCx = canvasPxX * scaleX;
    const cssCy = canvasPxY * scaleY;

    const fontSize = parseFontPx(ctx.font);
    // fontSize is in canvas pixels — scale to CSS pixels for the bounding-box estimate.
    const cssFontSize = fontSize * Math.min(scaleX, scaleY);

    // y in Canvas 2D is the text baseline; convert to top edge.
    const top  = Math.round(cssCy - cssFontSize);
    const left = Math.round(cssCx);
    const estW = Math.max(Math.round(cssFontSize * trimmed.length * 0.55), 8);
    const estH = Math.round(cssFontSize * 1.3);

    // Quantize position to an 8px grid so animation frames that redraw the same
    // text at the same position deduplicate to a single stable entry.
    const qx  = Math.round(left / 8) * 8;
    const qy  = Math.round(top  / 8) * 8;
    const key = `${trimmed}@${qx},${qy}`;

    const map = getMap(canvas);
    map.set(key, {
      text: trimmed,
      // cx/cy are CSS-pixel offsets within the canvas element (NOT canvas pixels).
      // __navy_canvas_elements() adds the canvas's CURRENT getBoundingClientRect()
      // at query time, so no draw-time viewport offset is stored here.
      cx: left,
      cy: top,
      cw: estW,
      ch: estH,
      ts: Date.now(),
    });

    // Bounded memory: evict the oldest entry once the cap is reached.
    if (map.size > 300) map.delete(map.keys().next().value);
  }

  // Sprite recorder: drawImage() destination rects. Canvas UIs that draw buttons,
  // icons, pieces, or cards from sprite sheets produce NO text — the sprite rect is
  // the only draw-call-level anchor available. Stored in the same per-canvas map as
  // text (entries carry kind:"img"), so frame-clear eviction applies uniformly.
  function recordImage(ctx, args) {
    const surface = ctx.canvas;
    if (!surface || surface.width < 4 || surface.height < 4) return;
    let dx, dy, dw, dh;
    const n = args.length;
    if (n >= 9)      { dx = args[5]; dy = args[6]; dw = args[7]; dh = args[8]; }
    else if (n >= 5) { dx = args[1]; dy = args[2]; dw = args[3]; dh = args[4]; }
    else if (n >= 3) {
      dx = args[1]; dy = args[2];
      const im = args[0];
      dw = (im && (im.width || im.videoWidth)) || 0;
      dh = (im && (im.height || im.videoHeight)) || 0;
    } else return;
    if (!(dw > 0 && dh > 0) || typeof dx !== "number" || typeof dy !== "number") return;

    // A ≥90%-coverage blit is a double-buffered frame present (VNC framebuffer push,
    // game back-buffer swap) — a frame boundary, not a sprite. 60–90% is a backdrop:
    // too big to be a click anchor, but not a frame signal either.
    const cover = (dw * dh) / (surface.width * surface.height);
    if (cover >= 0.9) { frameClear(ctx, dw, dh); return; }
    if (cover >= 0.6) return;

    const canvas = resolveVisibleCanvas(surface);
    if (!canvas) return;

    // Transform the dest origin; scale extents by the transform's axis scales.
    let px = dx, py = dy, sw = dw, sh = dh;
    try {
      const t = ctx.getTransform();
      px = t.a * dx + t.c * dy + t.e;
      py = t.b * dx + t.d * dy + t.f;
      sw = Math.abs(t.a) * dw;
      sh = Math.abs(t.d) * dh;
    } catch (_) {}

    const rect = getCanvasRect(canvas);
    const scaleX = (rect.cssW > 0 && surface.width  > 0) ? rect.cssW / surface.width  : 1;
    const scaleY = (rect.cssH > 0 && surface.height > 0) ? rect.cssH / surface.height : 1;
    const left = Math.round(px * scaleX);
    const top  = Math.round(py * scaleY);
    const w = Math.round(sw * scaleX);
    const h = Math.round(sh * scaleY);
    if (w < 10 || h < 10) return;                                  // particles/dots — not anchors
    if (w > rect.cssW * 0.6 && h > rect.cssH * 0.6) return;        // near-full backdrop

    const qx = Math.round(left / 8) * 8, qy = Math.round(top / 8) * 8;
    const key = "#img@" + qx + "," + qy + "," + (Math.round(w / 8) * 8) + "x" + (Math.round(h / 8) * 8);
    const map = getMap(canvas);
    map.set(key, { kind: "img", cx: left, cy: top, cw: w, ch: h, ts: Date.now() });
    if (map.size > 300) map.delete(map.keys().next().value);
  }

  // Canvases that have been frame-cleared at least once are "animated"; those that
  // never clear are "static" (drawn once, e.g. a canvas calculator or chart). Query
  // time-eviction applies only to animated canvases — static UI text must persist
  // as long as it is on screen, so it stays clickable however long ago it was drawn.
  const clearedCanvases = new WeakSet();

  // A full-canvas clearRect, or a full-canvas fillRect (background repaint), marks a
  // new frame — the correct staleness signal (NOT elapsed time). Drop the prior
  // frame's captured text for that canvas. Text drawn LATER in the same frame (after
  // this clear) is recorded normally and survives.
  function frameClear(ctx, w, h) {
    const surface = ctx.canvas;
    if (!surface) return;
    // Cheap coverage gate FIRST — this runs on every fillRect (a page render hot
    // path), so skip the instanceof + WeakMap work for the common small per-widget
    // fill. Only a ≥90%-coverage op (a frame clear / background repaint) proceeds.
    const full = surface.width * surface.height;
    if (!(full > 0 && (w || 0) * (h || 0) >= full * 0.9)) return;
    const canvas = resolveVisibleCanvas(surface);
    if (!canvas) return;
    clearedCanvases.add(canvas);
    const map = store.get(canvas);
    if (map) map.clear();
  }

  // Install text-capture + frame-clear hooks on a 2D context prototype. Shared by
  // CanvasRenderingContext2D and OffscreenCanvasRenderingContext2D (main-thread
  // offscreen) so the capture logic exists in exactly one place.
  function installContextHooks(proto) {
    if (!proto) return;
    const origFill = proto.fillText;
    if (typeof origFill === "function") {
      proto.fillText = function (text, x, y, maxWidth) {
        try { record(this, text, x, y); } catch (_) {}
        return maxWidth !== undefined ? origFill.call(this, text, x, y, maxWidth) : origFill.call(this, text, x, y);
      };
    }
    const origStroke = proto.strokeText;
    if (typeof origStroke === "function") {
      proto.strokeText = function (text, x, y, maxWidth) {
        try { record(this, text, x, y); } catch (_) {}
        return maxWidth !== undefined ? origStroke.call(this, text, x, y, maxWidth) : origStroke.call(this, text, x, y);
      };
    }
    const origClear = proto.clearRect;
    if (typeof origClear === "function") {
      proto.clearRect = function (x, y, w, h) {
        try { frameClear(this, w, h); } catch (_) {}
        return origClear.call(this, x, y, w, h);
      };
    }
    const origFillRect = proto.fillRect;
    if (typeof origFillRect === "function") {
      proto.fillRect = function (x, y, w, h) {
        try { frameClear(this, w, h); } catch (_) {}
        return origFillRect.call(this, x, y, w, h);
      };
    }
    const origDrawImage = proto.drawImage;
    if (typeof origDrawImage === "function") {
      proto.drawImage = function () {
        try { recordImage(this, arguments); } catch (_) {}
        return origDrawImage.apply(this, arguments);
      };
    }
  }

  installContextHooks(CanvasRenderingContext2D.prototype);
  if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
    installContextHooks(OffscreenCanvasRenderingContext2D.prototype);
  }

  // Capture the OffscreenCanvas → visible <canvas> association at transfer time,
  // so main-thread offscreen drawing can be positioned against the visible element.
  if (typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function") {
    const origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
      const off = origTransfer.apply(this, arguments);
      try { if (off) offscreenToVisible.set(off, this); } catch (_) {}
      return off;
    };
  }

  // Query API — called by background.js via CDP Runtime.evaluate at snapshot time.
  // Returns entries converted to absolute viewport coordinates (CSS pixels).
  //
  // Coordinate strategy: re-query getBoundingClientRect() at QUERY TIME (not draw
  // time). Draw-time vx/vy become stale the moment the page scrolls. For animated
  // canvases the difference is negligible; for static canvases (drawn once at page
  // load) any subsequent scroll would make the old vx/vy completely wrong. Using
  // the current rect corrects both cases with one cheap layout query per canvas.
  //
  // Visibility strategy: check that the canvas is currently within the viewport
  // bounds (bottom>0, top<vh, right>0, left<vw). The old check (width/height ≥ 20)
  // passes even when the canvas is entirely above or below the viewport, which
  // would return SOM elements at positions that are off-screen.
  //
  // TTL_MS: time-based eviction is a FALLBACK for animated canvases only. The
  // primary staleness signal is frame-clear (see frameClear): an animated canvas
  // purges its text every frame, so only current text remains. Static canvases
  // (never frame-cleared — e.g. a canvas calculator drawn once at load) are NOT
  // time-evicted, so their labels stay clickable no matter how long ago they were
  // drawn. This fixes the bug where a static canvas UI lost all its green-box SOM
  // labels after 4s, forcing the agent onto imprecise visual coordinate estimation.
  const TTL_MS = 8000;

  window.__navy_canvas_elements = function () {
    const now = Date.now();
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const result = [];

    document.querySelectorAll("canvas").forEach(function (canvas) {
      // Fresh rect at query time — used for both visibility and coordinates.
      let curLeft = 0, curTop = 0, visW = 0, visH = 0;
      try {
        const r = canvas.getBoundingClientRect();
        visW = r.width; visH = r.height;
        curLeft = r.left; curTop = r.top;
      } catch (_) {}

      if (visW < 20 || visH < 20) return;

      // Skip canvases scrolled completely outside the capture area.
      // background.js captures beyond the CSS viewport when screen.availHeight
      // exceeds the panel-reduced viewport. The extended capture covers at most
      // min(availHeight, scrollHeight − scrollY) CSS pixels below the viewport top.
      // captureVh mirrors that bound so only canvases actually in the screenshot
      // get SOM entries; using max(vh, …) as a floor keeps canvases that are
      // inside the normal viewport even when the page is shorter than the screen.
      const curRight  = curLeft + visW;
      const curBottom = curTop  + visH;
      const avail     = (window.screen && window.screen.availHeight) || vh;
      const remaining = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.scrollY || 0));
      const captureVh = Math.max(vh, Math.min(avail, remaining));
      if (curBottom < 0 || curRight < 0 || curTop > captureVh || curLeft > vw) return;

      const map = store.get(canvas);
      if (!map || map.size === 0) return;

      // Static canvases (never frame-cleared) keep their text indefinitely; only
      // animated canvases apply the time-based fallback eviction.
      const isAnimated = clearedCanvases.has(canvas);

      const texts = [];
      const images = [];
      for (const entry of map.values()) {
        if (isAnimated && now - entry.ts > TTL_MS) continue;
        // entry.cx/cy are CSS-pixel offsets within the canvas element (set at draw
        // time and invariant to scroll). Add the CURRENT canvas viewport position
        // (curLeft/curTop) so that elements stay correctly placed after any scroll.
        if (entry.kind === "img") {
          images.push({
            x: Math.round(curLeft + entry.cx + entry.cw / 2),
            y: Math.round(curTop  + entry.cy + entry.ch / 2),
            w: entry.cw,
            h: entry.ch,
          });
        } else {
          texts.push({
            text: entry.text,
            x: Math.round(curLeft + entry.cx + entry.cw / 2),
            y: Math.round(curTop  + entry.cy + entry.ch / 2),
            w: entry.cw,
            h: entry.ch,
          });
        }
      }

      // Cap sprites per canvas: largest first — big sprites are UI (buttons, cards,
      // pieces); the long tail is decorative repetition.
      if (images.length > 40) {
        images.sort(function (a, b) { return (b.w * b.h) - (a.w * a.h); });
        images.length = 40;
      }

      if (texts.length > 0 || images.length > 0) result.push({ texts, images });
    });

    return result;
  };
})();
