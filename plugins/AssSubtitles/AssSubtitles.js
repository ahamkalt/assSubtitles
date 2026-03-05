(async () => {
  const PLUGIN_ID = "AssSubtitles";
  const defaultSettings = { customSubsPrefix: "subs", subtitleLanguage: "en" };

  let jassubInstance = null;
  let currentSceneId = null;
  let workerBlobUrl = null;

  const baseURL =
    document.querySelector("base")?.getAttribute("href") ?? "/";
  const pluginAssetBase = baseURL + "plugin/" + PLUGIN_ID + "/assets/";

  console.log("[AssSubtitles] Plugin loaded. Asset base:", pluginAssetBase);

  function getSceneId() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
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
    await initJassub(resolvedUrl, sceneId);
  }

  async function initJassub(subUrl, sceneId) {
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

      const jassubOpts = {
        video: video,
        subUrl: subUrl,
        workerUrl: blobUrl,
        wasmUrl: pluginAssetBase + "wasm/jassub-worker.wasm",
        modernWasmUrl: pluginAssetBase + "wasm/jassub-worker-modern.wasm",
        availableFonts: {
          "liberation sans": pluginAssetBase + "default.woff2",
        },
      };
      console.log("[AssSubtitles] Creating JASSUB instance with opts:", jassubOpts);

      jassubInstance = new JASSUB(jassubOpts);
      console.log("[AssSubtitles] JASSUB instance created, waiting for ready...");

      await jassubInstance.ready;
      console.log("[AssSubtitles] JASSUB ready. Canvas parent:", jassubInstance._canvasParent);

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
    btn.title = "Toggle ASS Subtitles";
    btn.setAttribute("aria-label", "Toggle ASS Subtitles");
    btn.innerHTML =
      '<span style="font-size:11px;line-height:28px;font-weight:bold;pointer-events:none;">ASS</span>';

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
