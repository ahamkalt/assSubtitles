(async () => {
  const PLUGIN_ID = "AssSubtitles";
  const defaultSettings = { customSubsPrefix: "subs" };

  let jassubInstance = null;
  let currentSceneId = null;
  let workerBlobUrl = null;

  const baseURL =
    document.querySelector("base")?.getAttribute("href") ?? "/";
  const pluginAssetBase = baseURL + "plugin/" + PLUGIN_ID + "/assets/";

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
    const resp = await fetch(pluginAssetBase + "worker/worker.bundle.js");
    const text = await resp.text();
    const blob = new Blob([text], { type: "text/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
    return workerBlobUrl;
  }

  async function setup() {
    const sceneId = getSceneId();
    if (!sceneId) return;
    if (sceneId === currentSceneId && jassubInstance) return;

    await destroyJassub();
    currentSceneId = sceneId;

    const settings = {
      ...defaultSettings,
      ...(await csLib.getConfiguration(PLUGIN_ID, {})),
    };

    const prefix = (settings.customSubsPrefix || "subs").replace(
      /^\/|\/$/g,
      ""
    );

    const query = `query FindScene($id: ID!) {
      findScene(id: $id) {
        files { path }
      }
    }`;
    const result = await csLib.callGQL({ query, variables: { id: sceneId } });
    const files = result?.findScene?.files;
    if (!files || files.length === 0) return;

    const filePath = files[0].path;
    const fileName = filePath.split(/[/\\]/).pop();
    const baseName = fileName.replace(/\.[^.]+$/, "");

    const subUrl = baseURL + "custom/" + prefix + "/" + baseName + ".ass";

    let subAvailable = false;
    try {
      const head = await fetch(subUrl, { method: "HEAD" });
      subAvailable = head.ok;
    } catch (_) {}

    if (!subAvailable) {
      const ssaUrl = baseURL + "custom/" + prefix + "/" + baseName + ".ssa";
      try {
        const head = await fetch(ssaUrl, { method: "HEAD" });
        if (head.ok) subAvailable = ssaUrl;
      } catch (_) {}

      if (subAvailable) {
        await initJassub(subAvailable, sceneId);
      }
      return;
    }

    await initJassub(subUrl, sceneId);
  }

  async function initJassub(subUrl, sceneId) {
    if (currentSceneId !== sceneId) return;

    const playerEl = document.getElementById("VideoJsPlayer");
    if (!playerEl || !playerEl.player) return;

    const vjsPlayer = playerEl.player;
    const video = vjsPlayer.tech({ IWillNotUseThisInPlugins: true })?.el();
    if (!video || !(video instanceof HTMLVideoElement)) return;

    try {
      const mod = await import(pluginAssetBase + "jassub.bundle.js");
      const JASSUB = mod.default;

      const blobUrl = await getWorkerBlobUrl();

      jassubInstance = new JASSUB({
        video: video,
        subUrl: subUrl,
        workerUrl: blobUrl,
        wasmUrl: pluginAssetBase + "wasm/jassub-worker.wasm",
        modernWasmUrl: pluginAssetBase + "wasm/jassub-worker-modern.wasm",
        availableFonts: {
          "liberation sans": pluginAssetBase + "default.woff2",
        },
      });

      await jassubInstance.ready;

      addToggleButton(vjsPlayer);
    } catch (err) {
      console.error("[AssSubtitles] Failed to init jassub:", err);
      await destroyJassub();
    }
  }

  function addToggleButton(vjsPlayer) {
    const controlBar = vjsPlayer.controlBar?.el();
    if (!controlBar) return;

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
