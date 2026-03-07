(async () => {
  const PLUGIN_ID = "AssSubtitles";
  const defaultSettings = {
    customSubsPrefix: "subs",
    subtitleLanguage: "en",
    useCustomFontsFolder: false,
    customFontsPrefix: "",
    fontFilenames: "",
  };

  let jassubInstance = null;
  let currentSceneId = null;
  let workerBlobUrl = null;

  const baseURL =
    document.querySelector("base")?.getAttribute("href") ?? "/";
  const pluginAssetBase = baseURL + "plugin/" + PLUGIN_ID + "/assets/";

  // Absolute base for URLs passed into the Web Worker — relative paths fail
  // inside workers loaded from blob: URLs because there is no base to resolve against.
  function toAbsolute(url) {
    return new URL(url, window.location.href).href;
  }
  const absAssetBase = toAbsolute(pluginAssetBase);

  console.log("[AssSubtitles] Plugin loaded. Asset base:", pluginAssetBase);

  function getSceneId() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function asBool(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.trim().toLowerCase() === "true";
    return false;
  }

  function extractAssFontFamilies(assText) {
    const fonts = new Set();
    const lines = assText.split(/\r?\n/);
    let inStyleSection = false;
    let fontNameIndex = -1;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^\[[^\]]+\]$/.test(trimmed)) {
        inStyleSection = /^\[(V4\+?\s+Styles)\]$/i.test(trimmed);
        fontNameIndex = -1;
        continue;
      }

      if (inStyleSection) {
        if (/^Format:/i.test(trimmed)) {
          const fields = trimmed
            .slice(7)
            .split(",")
            .map((f) => f.trim().toLowerCase());
          fontNameIndex = fields.indexOf("fontname");
          continue;
        }

        if (fontNameIndex >= 0 && /^Style:/i.test(trimmed)) {
          const parts = trimmed
            .slice(6)
            .split(",")
            .map((p) => p.trim());
          if (fontNameIndex < parts.length && parts[fontNameIndex]) {
            fonts.add(parts[fontNameIndex]);
          }
        }
      }
    }

    // Also scan inline override tags like {\fnSome Font Name}
    for (const match of assText.matchAll(/\\fn([^\\}\r\n]+)/g)) {
      const name = match[1]?.trim();
      if (name) fonts.add(name);
    }

    return [...fonts];
  }

  async function fetchGoogleFontBinary(family, italic, weight) {
    const familyParam = encodeURIComponent(family.trim()).replace(/%20/g, "+");
    const cssUrl =
      `https://fonts.googleapis.com/css2?family=${familyParam}` +
      `:ital,wght@${italic ? 1 : 0},${weight}&display=swap`;

    const cssResp = await fetch(cssUrl);
    if (!cssResp.ok) return null;
    const css = await cssResp.text();

    const woff2Matches = [...css.matchAll(/url\(([^)]+)\)\s*format\(['"]woff2['"]\)/g)];
    if (!woff2Matches.length) return null;

    // Google CSS typically puts the latin subset near the end.
    const fontUrl = woff2Matches[woff2Matches.length - 1][1].replace(/^['"]|['"]$/g, "");
    const fontResp = await fetch(fontUrl);
    if (!fontResp.ok) return null;
    return new Uint8Array(await fontResp.arrayBuffer());
  }

  async function destroyJassub() {
    if (jassubInstance) {
      try {
        await jassubInstance.destroy();
      } catch (_) {}
      jassubInstance = null;
    }
    currentSceneId = null;
  }

  async function getWorkerBlobUrl() {
    if (workerBlobUrl) return workerBlobUrl;
    const workerUrl = pluginAssetBase + "worker/worker.bundle.js";
    console.log("[AssSubtitles] Fetching worker from:", workerUrl);
    const resp = await fetch(workerUrl);
    if (!resp.ok)
      throw new Error("Worker fetch failed: " + resp.status + " " + workerUrl);
    const text = await resp.text();
    const blob = new Blob([text], { type: "text/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
    console.log("[AssSubtitles] Worker blob URL created:", workerBlobUrl);
    return workerBlobUrl;
  }

  async function setup() {
    console.log("[AssSubtitles] setup() called, pathname:", window.location.pathname);

    const sceneId = getSceneId();
    if (!sceneId) {
      console.log("[AssSubtitles] No scene ID found in URL, skipping.");
      return;
    }
    if (sceneId === currentSceneId && jassubInstance) {
      console.log("[AssSubtitles] Same scene already active, skipping.");
      return;
    }

    await destroyJassub();
    currentSceneId = sceneId;
    console.log("[AssSubtitles] Setting up for scene ID:", sceneId);

    const rawSettings = await csLib.getConfiguration(PLUGIN_ID, {});
    const settings = { ...defaultSettings, ...rawSettings };
    console.log("[AssSubtitles] Settings:", settings);

    const prefix = (settings.customSubsPrefix || "subs").replace(/^\/|\/$/g, "");
    const lang = (settings.subtitleLanguage ?? "en").trim();
    console.log("[AssSubtitles] Using prefix:", prefix, "language:", lang || "(none)");

    const query = `query FindScene($id: ID!) {
      findScene(id: $id) {
        files { path }
      }
    }`;
    const result = await csLib.callGQL({ query, variables: { id: sceneId } });
    const files = result?.findScene?.files;
    console.log("[AssSubtitles] Scene files from GraphQL:", files);

    if (!files || files.length === 0) {
      console.log("[AssSubtitles] No files found for scene, aborting.");
      return;
    }

    const filePath = files[0].path;
    const fileName = filePath.split(/[/\\]/).pop();
    const baseName = fileName.replace(/\.[^.]+$/, "");
    console.log("[AssSubtitles] Video file path:", filePath, "→ basename:", baseName);

    const encodedPrefix = encodeURIComponent(prefix);

    // Build candidate filenames in priority order:
    // 1. {basename}.ass          — no language code
    // 2. {basename}.{lang}.ass   — with language code (e.g. .en.ass)
    // 3. {basename}.ssa
    // 4. {basename}.{lang}.ssa
    const candidates = [baseName + ".ass"];
    if (lang) candidates.push(baseName + "." + lang + ".ass");
    candidates.push(baseName + ".ssa");
    if (lang) candidates.push(baseName + "." + lang + ".ssa");

    let resolvedUrl = null;
    for (const filename of candidates) {
      const url =
        baseURL + "custom/" + encodedPrefix + "/" + encodeURIComponent(filename);
      console.log("[AssSubtitles] Trying:", url);
      try {
        const head = await fetch(url, { method: "HEAD" });
        console.log("[AssSubtitles] HEAD →", head.status, head.statusText, "for", filename);
        if (head.ok) {
          resolvedUrl = url;
          break;
        }
      } catch (e) {
        console.log("[AssSubtitles] HEAD failed for", filename, ":", e);
      }
    }

    if (!resolvedUrl) {
      console.log(
        "[AssSubtitles] No subtitle file found. Tried:",
        candidates.join(", "),
        "— check custom served folder setting and filename."
      );
      return;
    }

    console.log("[AssSubtitles] Subtitle found at:", resolvedUrl);
    await initJassub(resolvedUrl, sceneId, settings, prefix);
  }

  async function initJassub(subUrl, sceneId, settings, prefix) {
    if (currentSceneId !== sceneId) {
      console.log("[AssSubtitles] Scene changed before jassub init, aborting.");
      return;
    }

    const playerEl = document.getElementById("VideoJsPlayer");
    if (!playerEl || !playerEl.player) {
      console.log("[AssSubtitles] VideoJsPlayer element or player not found.");
      return;
    }

    const vjsPlayer = playerEl.player;

    // Try multiple methods to get the <video> element
    let video =
      vjsPlayer.tech({ IWillNotUseThisInPlugins: true })?.el() ??
      playerEl.querySelector("video");
    if (!video || !(video instanceof HTMLVideoElement)) {
      console.log("[AssSubtitles] Could not find HTMLVideoElement. Tech el:", video);
      return;
    }
    console.log("[AssSubtitles] Got video element:", video);

    try {
      console.log("[AssSubtitles] Importing jassub from:", pluginAssetBase + "jassub.bundle.js");
      const mod = await import(pluginAssetBase + "jassub.bundle.js");
      const JASSUB = mod.default;
      console.log("[AssSubtitles] jassub imported, JASSUB:", typeof JASSUB);

      const blobUrl = await getWorkerBlobUrl();

      // Option A default: auto-fetch families referenced by ASS from Google Fonts
      // and inject binary font data directly into libass. Keep manual folder-based
      // loading available as an explicit opt-in.
      const fontData = [];
      const customAvailableFonts = {};
      let inferredDefaultFont = null;
      const useCustomFontsFolder = asBool(settings.useCustomFontsFolder);
      const fontsPrefix = (settings.customFontsPrefix || prefix || "").replace(/^\/|\/$/g, "");
      if (useCustomFontsFolder && fontsPrefix && settings.fontFilenames) {
        const encodedFontsPrefix = encodeURIComponent(fontsPrefix);
        const fileList = settings.fontFilenames
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean);
        console.log("[AssSubtitles] Fetching", fileList.length, "font file(s) from prefix:", fontsPrefix);
        await Promise.all(
          fileList.map(async (filename) => {
            const url = toAbsolute(
              baseURL + "custom/" + encodedFontsPrefix + "/" + encodeURIComponent(filename)
            );
            const base = filename.replace(/\.[^.]+$/, "").toLowerCase();
            try {
              const resp = await fetch(url);
              if (!resp.ok) {
                console.warn("[AssSubtitles] Font fetch failed:", resp.status, url);
                return;
              }
              const buf = await resp.arrayBuffer();
              fontData.push(new Uint8Array(buf));
              console.log("[AssSubtitles] Font loaded:", filename, `(${buf.byteLength} bytes)`);

              // jassub's worker looks up availableFonts by exact "fontname" or
              // "fontname weight". Provide both filename-derived aliases and
              // common family/weight aliases (e.g. "lato", "lato bold").
              const normalized = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
              customAvailableFonts[normalized] = url;

              const styleBySuffix = [
                [" blackitalic", " black italic"],
                [" black", " black"],
                [" bolditalic", " bold italic"],
                [" bold", " bold"],
                [" italic", " italic"],
                [" lightitalic", " light italic"],
                [" light", " light"],
                [" thinitalic", " thin italic"],
                [" thin", " thin"],
                [" regular", " regular"],
              ];

              for (const [suffix, alias] of styleBySuffix) {
                if (normalized.endsWith(suffix)) {
                  const family = normalized.slice(0, -suffix.length).trim();
                  if (family) {
                    customAvailableFonts[family + alias] = url;
                    // Prefer regular face as family default when available.
                    if (!customAvailableFonts[family] || suffix === " regular") {
                      customAvailableFonts[family] = url;
                    }
                    if (!inferredDefaultFont || suffix === " regular") {
                      inferredDefaultFont = family;
                    }
                  }
                  break;
                }
              }
            } catch (e) {
              console.warn("[AssSubtitles] Font fetch error:", filename, e);
            }
          })
        );
        console.log("[AssSubtitles] Loaded", fontData.length, "of", fileList.length, "fonts.");
        if (Object.keys(customAvailableFonts).length > 0) {
          console.log("[AssSubtitles] availableFonts aliases:", Object.keys(customAvailableFonts));
        }
      } else if (useCustomFontsFolder) {
        console.log(
          "[AssSubtitles] Manual font folder mode enabled but no usable prefix/filenames configured."
        );
      } else {
        console.log(
          "[AssSubtitles] Manual font folder mode disabled. Using queryFonts=localandremote (Google/local)."
        );
      }

      // Fetch the subtitle content here in the main thread so we can set the track
      // AFTER fonts are registered — fonts passed via the constructor option arrive in
      // the worker concurrently with track creation, so libass may not see them in time.
      const absSubUrl = toAbsolute(subUrl);
      console.log("[AssSubtitles] Fetching subtitle content from:", absSubUrl);
      const subResp = await fetch(absSubUrl);
      if (!subResp.ok) {
        console.warn("[AssSubtitles] Subtitle content fetch failed:", subResp.status);
        return;
      }
      const subtitleContent = await subResp.text();
      console.log("[AssSubtitles] Subtitle content fetched, length:", subtitleContent.length, "chars");

      if (currentSceneId !== sceneId) {
        console.log("[AssSubtitles] Scene changed during subtitle fetch, aborting.");
        return;
      }

      if (!useCustomFontsFolder) {
        const families = extractAssFontFamilies(subtitleContent);
        if (families.length) {
          console.log("[AssSubtitles] ASS font families detected:", families);
        } else {
          console.log("[AssSubtitles] No ASS font families detected; using default fallback font.");
        }

        const variantPlan = [
          { italic: false, weight: 400 },
          { italic: false, weight: 700 },
          { italic: true, weight: 400 },
          { italic: true, weight: 700 },
        ];

        for (const family of families) {
          const key = family.trim().toLowerCase();
          if (!key) continue;
          let loadedForFamily = 0;

          await Promise.all(
            variantPlan.map(async ({ italic, weight }) => {
              try {
                const bin = await fetchGoogleFontBinary(family, italic, weight);
                if (!bin) return;
                fontData.push(bin);
                loadedForFamily += 1;
              } catch (_) {}
            })
          );

          if (loadedForFamily > 0) {
            inferredDefaultFont ||= key;
            console.log(
              `[AssSubtitles] Google font loaded for "${family}" variants: ${loadedForFamily}/${variantPlan.length}`
            );
          } else {
            console.log(`[AssSubtitles] Google font unavailable for "${family}" (will fallback).`);
          }
        }

        if (fontData.length) {
          console.log("[AssSubtitles] Total embedded Google font binaries:", fontData.length);
        }
      }

      // Start JASSUB with an empty placeholder track. We'll load the real subtitle
      // after explicitly calling renderer.addFonts() so libass has the font data
      // ready before it parses any events.
      const minimalAssTrack = `[Script Info]
Script Type: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

      const jassubOpts = {
        video: video,
        subContent: minimalAssTrack,
        workerUrl: blobUrl,
        wasmUrl: absAssetBase + "wasm/jassub-worker.wasm",
        modernWasmUrl: absAssetBase + "wasm/jassub-worker-modern.wasm",
        availableFonts: {
          "liberation sans": absAssetBase + "default.woff2",
          ...customAvailableFonts,
        },
        queryFonts: "localandremote",
        fonts: [],
        ...(inferredDefaultFont ? { defaultFont: inferredDefaultFont } : {}),
      };
      console.log("[AssSubtitles] Creating JASSUB instance (empty track, fonts added after ready)...");

      jassubInstance = new JASSUB(jassubOpts);
      console.log("[AssSubtitles] JASSUB instance created, waiting for ready...");

      await jassubInstance.ready;
      console.log("[AssSubtitles] JASSUB ready. Canvas parent:", jassubInstance._canvasParent);

      // Add fonts explicitly NOW, before the subtitle track is set.
      // renderer.addFonts() resolves only after the worker has called _allocFonts
      // and reloadFonts(), so libass's font database is fully updated before we proceed.
      if (fontData.length > 0) {
        await jassubInstance.renderer.addFonts(fontData);
        console.log("[AssSubtitles] Fonts added to libass renderer (", fontData.length, "files).");
      }

      if (currentSceneId !== sceneId) {
        console.log("[AssSubtitles] Scene changed during font loading, aborting.");
        return;
      }

      // Set the real subtitle track — libass now has the font data and will find
      // Lato (and other preloaded faces) when it matches font names in events.
      await jassubInstance.renderer.setTrack(subtitleContent);
      console.log("[AssSubtitles] Subtitle track set after fonts are registered.");

      const overlay = jassubInstance._canvasParent;
      if (overlay) {
        // Let the overlay sit above the video but *below* the Video.js controls.
        // We avoid setting an explicit z-index so the control bar stays on top.
        overlay.style.pointerEvents = "none";

        // Size and position the overlay to match the video element exactly, so
        // subtitles sit over the video only and not over the progress bar / controls.
        function syncOverlayToVideo() {
          if (!overlay || !video) return;
          overlay.style.position = "absolute";
          overlay.style.top = video.offsetTop + "px";
          overlay.style.left = video.offsetLeft + "px";
          overlay.style.width = video.offsetWidth + "px";
          overlay.style.height = video.offsetHeight + "px";
        }
        syncOverlayToVideo();

        const overlayRo = new ResizeObserver(() => syncOverlayToVideo());
        overlayRo.observe(video);
        video.addEventListener("loadedmetadata", syncOverlayToVideo);
      }

      // Force an initial resize+render. This is necessary for paused videos
      // because requestVideoFrameCallback only fires when new frames are presented.
      try {
        await jassubInstance.resize(true);
        console.log("[AssSubtitles] Initial resize done. Canvas size:", {
          w: jassubInstance._canvas?.width,
          h: jassubInstance._canvas?.height,
        });
      } catch (e) {
        console.log("[AssSubtitles] Resize error:", e);
      }

      // Re-resize when the video starts playing or metadata loads — covers the
      // case where videoWidth was 0 at init time and the ResizeObserver didn't fire.
      const triggerResize = () => {
        if (jassubInstance) jassubInstance.resize(true).catch(() => {});
      };
      video.addEventListener("loadedmetadata", triggerResize, { once: true });
      video.addEventListener("playing", triggerResize, { once: true });

      addToggleButton(vjsPlayer);
    } catch (err) {
      console.error("[AssSubtitles] Failed to init jassub:", err);
      await destroyJassub();
    }
  }

  function addToggleButton(vjsPlayer) {
    const controlBar = vjsPlayer.controlBar?.el();
    if (!controlBar) {
      console.log("[AssSubtitles] No control bar found, skipping toggle button.");
      return;
    }

    if (controlBar.querySelector(".ass-toggle-btn")) return;

    const btn = document.createElement("button");
    btn.className = "vjs-control vjs-button ass-toggle-btn";
    btn.title = "Toggle subtitles";
    btn.setAttribute("aria-label", "Toggle subtitles");
    btn.innerHTML =
      '<span style="font-size:11px;line-height:28px;font-weight:bold;pointer-events:none;">SUB</span>';

    let visible = true;
    btn.addEventListener("click", () => {
      if (!jassubInstance) return;
      visible = !visible;
      const canvas = jassubInstance._canvasParent || jassubInstance._canvas;
      if (canvas) {
        canvas.style.display = visible ? "" : "none";
      }
      btn.style.opacity = visible ? "1" : "0.5";
    });

    const fullscreenBtn = controlBar.querySelector(".vjs-fullscreen-control");
    if (fullscreenBtn) {
      controlBar.insertBefore(btn, fullscreenBtn);
    } else {
      controlBar.appendChild(btn);
    }
    console.log("[AssSubtitles] Toggle button added to control bar.");
  }

  PluginApi.Event.addEventListener("stash:location", () => {
    const sceneId = getSceneId();
    if (!sceneId || sceneId !== currentSceneId) {
      destroyJassub();
      const btn = document.querySelector(".ass-toggle-btn");
      if (btn) btn.remove();
    }
  });

  csLib.PathElementListener("/scenes/", "#VideoJsPlayer", setup);
})();
