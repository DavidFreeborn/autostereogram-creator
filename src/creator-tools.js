import {
  createLayer,
  createPreset,
  drawDepth,
  drawScene,
  composeDepth,
} from "./scene.js";
import { renderTextureSample } from "./stereogram.js";
import { estimateDepth } from "./depth-estimator.js";
import { readImage } from "./files.js";

export function createCreatorTools({
  editor,
  requestFrame,
  setView,
  scheduleRender,
  drawFrame,
  importDepth,
  getRevision,
}) {
  const $ = (id) => document.getElementById(id);
  let revealing = false,
    guideScene = null,
    guideStep = 0,
    gentle = null;
  let photo = null,
    estimation = null,
    controller = null,
    photoSequence = 0;
  let swatchKey = "",
    swatchTexture = null,
    currentView = "relief";
  const imageOn = (canvas, image) => {
    canvas.width = image.width;
    canvas.height = image.height;
    canvas
      .getContext("2d")
      .putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  };
  function reveal(value) {
    revealing = value && currentView === "stereo";
    $("reveal").setAttribute("aria-pressed", String(revealing));
    drawFrame();
  }
  $("reveal").onpointerdown = (event) => {
    event.preventDefault();
    $("reveal").setPointerCapture(event.pointerId);
    reveal(true);
  };
  $("reveal").onpointerup = $("reveal").onpointercancel = () => reveal(false);
  $("reveal").onkeydown = (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      reveal(true);
    }
  };
  $("reveal").onkeyup = (event) => {
    if ([" ", "Enter"].includes(event.key)) {
      event.preventDefault();
      reveal(false);
    }
  };
  $("reveal").onblur = () => reveal(false);
  window.addEventListener("blur", () => reveal(false));
  document.addEventListener("keydown", (event) => {
    if (
      event.key.toLowerCase() === "r" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.target.matches("input,textarea,select") &&
      !document.querySelector("dialog[open]")
    )
      reveal(true);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key.toLowerCase() === "r") reveal(false);
  });

  function updateGuide() {
    const cross = editor.state.settings.mode === "cross";
    const steps = [
      [
        "Bring the dots together",
        cross
          ? "Look in front of the screen until the two dots meet as a third dot between them."
          : "Look through the screen until the two dots meet as a third dot between them.",
      ],
      [
        "Find the simple shape",
        "Keep the middle dot steady and let the pattern sharpen. A rounded shape is hidden in this practice image.",
      ],
      [
        "Try your design",
        "Use the same viewing position with your own image. Hold Reveal whenever you want to check the shape. Take a break if your eyes feel uncomfortable.",
      ],
    ];
    $("guide-step").textContent = steps[guideStep][0];
    $("guide-copy").textContent = steps[guideStep][1];
    $("guide-count").textContent = `${guideStep + 1} of 3`;
    $("guide-back").disabled = guideStep === 0;
    $("guide-next").textContent = guideStep === 2 ? "Done" : "Next";
    const previous = guideScene;
    guideScene =
      guideStep === 1
        ? {
            name: "Practice shape",
            layers: [{ ...createLayer("sphere"), size: 0.7, depth: 0.75 }],
          }
        : null;
    if (previous || guideScene) scheduleRender();
  }
  function closeGuide() {
    $("viewing-assistant").hidden = true;
    $("viewing-help").setAttribute("aria-expanded", "false");
    if (guideScene) {
      guideScene = null;
      scheduleRender();
    }
  }
  $("viewing-help").onclick = () => {
    if (!$("viewing-assistant").hidden) return closeGuide();
    $("viewing-assistant").hidden = false;
    $("viewing-help").setAttribute("aria-expanded", "true");
    guideStep = 0;
    editor.transact(
      "Show alignment dots",
      () => (editor.state.settings.dots = true),
    );
    updateGuide();
  };
  $("guide-close").onclick = closeGuide;
  $("guide-back").onclick = () => {
    guideStep = Math.max(0, guideStep - 1);
    updateGuide();
  };
  $("guide-next").onclick = () => {
    if (guideStep === 2) closeGuide();
    else {
      guideStep++;
      updateGuide();
    }
  };
  $("guide-gentler").onclick = () => {
    if (!gentle)
      gentle = {
        strength: editor.state.settings.strength,
        repeat: editor.state.settings.repeat,
      };
    editor.transact("Try gentler depth", () => {
      editor.state.settings.strength = Math.min(
        28,
        editor.state.settings.strength * 0.65,
      );
      editor.state.settings.repeat = Math.min(80, editor.state.settings.repeat);
    });
    $("guide-restore").hidden = false;
  };
  $("guide-restore").onclick = () => {
    if (gentle)
      editor.transact("Restore viewing settings", () =>
        Object.assign(editor.state.settings, gentle),
      );
    gentle = null;
    $("guide-restore").hidden = true;
  };

  function refreshTextures() {
    const s = editor.state.settings,
      custom = s.palette === "custom";
    $("texture-families").hidden = custom;
    $("palette-field").hidden = custom;
    $("shuffle").hidden = custom;
    $("generated-texture").hidden = !custom;
    $("texture-depth").hidden = !custom;
    $("import-texture").textContent = custom
      ? "Replace texture"
      : "Import texture";
    $("custom-texture-options").hidden = !custom;
    $("texture-repeat").value = s.textureRepeat || "both";
    $("texture-scale").value = s.textureScale || 100;
    $("texture-scale-value").textContent = `${s.textureScale || 100}%`;
    const key = JSON.stringify([
      s.palette,
      s.seed,
      s.grain,
      s.textureStyle,
      s.textureScale,
      s.textureRepeat,
    ]);
    if (key === swatchKey && swatchTexture === editor.state.texture) return;
    swatchTexture = editor.state.texture;
    swatchKey = key;
    for (const button of document.querySelectorAll("[data-texture-style]")) {
      button.setAttribute(
        "aria-pressed",
        String((s.textureStyle || "stipple") === button.dataset.textureStyle),
      );
      const c = button.querySelector("canvas");
      const sample = renderTextureSample({
        ...s,
        palette: custom ? "verdigris" : s.palette,
        width: c.width,
        height: c.height,
        repeat: 55,
        textureStyle: button.dataset.textureStyle,
      });
      imageOn(c, { ...sample, data: sample.pixels });
    }
    if (custom && editor.state.texture) {
      const sample = renderTextureSample({
        ...s,
        palette: "verdigris",
        width: 320,
        height: 110,
        repeat: 70,
        texture: editor.state.texture,
      });
      imageOn($("texture-preview"), { ...sample, data: sample.pixels });
    }
  }
  for (const button of document.querySelectorAll("[data-texture-style]"))
    button.onclick = () =>
      editor.transact("Change texture", () => {
        editor.state.settings.textureStyle = button.dataset.textureStyle;
      });
  $("texture-repeat").onchange = () =>
    editor.transact(
      "Change texture repeat",
      () => (editor.state.settings.textureRepeat = $("texture-repeat").value),
    );
  $("texture-scale").oninput = () => {
    editor.begin("Zoom texture");
    editor.state.settings.textureScale = Number($("texture-scale").value);
    refreshTextures();
    scheduleRender(true);
  };
  $("texture-scale").onchange = $("texture-scale").onblur = () => {
    editor.commit();
    scheduleRender();
  };

  let diagnosticRun = 0;
  $("check-detail").onclick = () => {
    $("detail-dialog").showModal();
    $("run-detail").click();
  };
  $("run-detail").onclick = async () => {
    const width = Number($("detail-width").value),
      height = Math.round(
        (width * editor.state.document.height) / editor.state.document.width,
      );
    if (
      !Number.isInteger(width) ||
      width < 320 ||
      width > 6000 ||
      height > 6000 ||
      width * height > 20e6
    ) {
      $("detail-status").textContent =
        "Use 320–6,000 pixels per side, up to 20 million pixels.";
      return;
    }
    const id = ++diagnosticRun,
      revision = getRevision();
    $("run-detail").disabled = true;
    $("detail-status").textContent = "Checking the encoded depth…";
    try {
      const result = await requestFrame({
        width,
        height,
        output: "depth",
        diagnostics: true,
      });
      if (id !== diagnosticRun || revision !== getRevision()) return;
      const p = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < result.depth.length; i++) {
        const n = Math.round(result.depth[i] * 255),
          flag = result.diagnosticMask[i];
        p.set(
          flag & 2
            ? [53, 114, 160, 255]
            : flag & 1
              ? [188, 116, 33, 255]
              : [n, n, n, 255],
          i * 4,
        );
      }
      imageOn($("detail-preview"), { width, height, data: p });
      const d = result.diagnostics;
      $("detail-results").replaceChildren();
      for (const [label, value] of [
        ["Encoded depth levels", d.depthLevelsUsed],
        ["Flattened depth changes", d.collapsedEdges.toLocaleString()],
        [
          "Fine-detail pixels",
          d.referenceScale === 2
            ? d.subpixelPixels.toLocaleString()
            : "Reference limit reached",
        ],
      ]) {
        const term = document.createElement("dt"),
          detail = document.createElement("dd");
        term.textContent = label;
        detail.textContent = value;
        $("detail-results").append(term, detail);
      }
      $("detail-status").textContent =
        `${width.toLocaleString()} × ${height.toLocaleString()} px${d.referenceScale === 1 ? " · Fine-detail comparison is limited to smaller outputs." : ""}`;
    } catch (e) {
      $("detail-status").textContent = e.message;
    } finally {
      $("run-detail").disabled = false;
    }
  };

  function showPhotoDepth(depth) {
    if (!photo) return;
    if (depth && estimation)
      drawDepth(
        $("image-preview"),
        estimation.data,
        estimation.width,
        estimation.height,
      );
    else imageOn($("image-preview"), photo.asset.imageData);
    $("photo-original").setAttribute("aria-pressed", String(!depth));
    $("photo-depth").setAttribute("aria-pressed", String(depth));
    $("use-depth-image").hidden = !photo.file || (!!estimation && depth);
  }
  $("photo-original").onclick = () => showPhotoDepth(false);
  $("photo-depth").onclick = () => showPhotoDepth(true);
  function stopEstimation() {
    controller?.abort();
    controller = null;
  }
  $("image-dialog").addEventListener("close", () => {
    photoSequence++;
    stopEstimation();
    photo = null;
    estimation = null;
  });
  $("cancel-estimate").onclick = stopEstimation;
  $("estimate-photo").onclick = async () => {
    if (!photo) return;
    const sequence = photoSequence;
    controller = new AbortController();
    $("estimate-photo").disabled = true;
    $("use-depth-image").disabled = true;
    $("cancel-estimate").hidden = false;
    $("photo-progress").hidden = false;
    try {
      const result = await estimateDepth(photo.asset.imageData, {
        signal: controller.signal,
        onProgress: (p) => {
          if (sequence !== photoSequence) return;
          $("photo-status").textContent = p.message;
          if (Number.isFinite(p.fraction)) {
            $("photo-progress").value = p.fraction;
            $("photo-progress").max = 1;
          } else $("photo-progress").removeAttribute("value");
        },
      });
      if (sequence !== photoSequence) return;
      // Keep transparent source regions empty in the editable depth layer.
      const source = photo.asset.imageData;
      for (let y = 0; y < result.height; y++)
        for (let x = 0; x < result.width; x++) {
          const sx = Math.min(
              source.width - 1,
              Math.floor(((x + 0.5) * source.width) / result.width),
            ),
            sy = Math.min(
              source.height - 1,
              Math.floor(((y + 0.5) * source.height) / result.height),
            );
          result.data[y * result.width + x] *=
            source.data[(sy * source.width + sx) * 4 + 3] / 255;
        }
      estimation = result;
      $("photo-tabs").hidden = false;
      $("photo-download-note").hidden = true;
      $("estimate-photo").hidden = true;
      $("photo-depth").disabled = false;
      $("add-photo-depth").hidden = false;
      $("photo-status").textContent = "Depth estimated.";
      showPhotoDepth(true);
    } catch (e) {
      if (sequence === photoSequence)
        $("photo-status").textContent =
          e.name === "AbortError" ? "Estimation cancelled." : e.message;
    } finally {
      if (sequence === photoSequence) {
        $("estimate-photo").disabled = false;
        $("use-depth-image").disabled = false;
        $("cancel-estimate").hidden = true;
        $("photo-progress").hidden = true;
        controller = null;
      }
    }
  };
  $("use-depth-image").onclick = async () => {
    if (!photo) return;
    try {
      await importDepth(photo.file);
      $("image-dialog").close();
    } catch (e) {
      $("photo-status").textContent = e.message;
    }
  };
  $("add-photo-depth").onclick = () => {
    if (!estimation || !photo) return;
    const doc = editor.state.document,
      aspect = estimation.height / estimation.width,
      unit = Math.min(doc.width, doc.height),
      fit = 0.85 * Math.min(doc.width / unit, doc.height / (aspect * unit));
    const layer = {
      ...createLayer("paint"),
      name: photo.asset.name + " · estimated depth",
      field: {
        width: estimation.width,
        height: estimation.height,
        data: estimation.data,
      },
      aspect,
      depth: 1,
      size: Math.min(4, fit),
      scaleX: 1,
      scaleY: 1,
    };
    layer.scaleX = layer.scaleY = fit / layer.size;
    try {
      editor.add([layer]);
      $("image-dialog").close();
      setView("relief");
    } catch (e) {
      $("photo-status").textContent = e.message;
    }
  };
  async function openImage(file, suppliedAsset) {
    const revision = getRevision(),
      asset = suppliedAsset || (await readImage(file));
    if (revision !== getRevision())
      throw new Error(
        "The design changed during import. Choose the image again.",
      );
    photoSequence++;
    photo = { file, asset };
    $("image-title").textContent = file ? "Add an image" : "Depth from texture";
    estimation = null;
    $("photo-tabs").hidden = true;
    $("photo-download-note").hidden = false;
    $("estimate-photo").hidden = false;
    $("use-depth-image").hidden = false;
    $("photo-status").textContent = "";
    $("photo-depth").disabled = true;
    $("add-photo-depth").hidden = true;
    $("photo-progress").hidden = true;
    $("cancel-estimate").hidden = true;
    $("estimate-photo").disabled = false;
    $("use-depth-image").disabled = false;
    showPhotoDepth(false);
    $("image-dialog").showModal();
  }

  $("generated-texture").onclick = () =>
    editor.transact("Use generated texture", () => {
      editor.state.settings.palette = "verdigris";
    });

  $("texture-depth").onclick = async () => {
    if (!editor.state.texture) return;
    await openImage(null, { imageData: editor.state.texture, name: "Texture" });
    $("estimate-photo").click();
  };

  let galleryReady = false;
  function populateGallery() {
    if (galleryReady) return;
    galleryReady = true;
    for (const [id, label] of [
      ["blank", "Blank canvas"],
      ["typography", "Recessed lettering"],
      ["architecture", "Portals"],
      ["landscape", "Landscape"],
      ["sculpture", "Sculpture"],
      ["orbital", "Orbital forms"],
      ["whale", "Whale & arches"],
      ["terraces", "Terraces"],
      ["type", "Lettering"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.example = id;
      button.setAttribute("aria-pressed", String($("preset").value === id));
      const canvas = document.createElement("canvas");
      canvas.width = 360;
      canvas.height = 216;
      canvas.setAttribute("aria-hidden", "true");
      drawScene(canvas, composeDepth(createPreset(id), 360, 216), 360, 216);
      const span = document.createElement("span");
      span.textContent = label;
      button.append(canvas, span);
      button.onclick = () => {
        $("preset").value = id;
        syncGallery();
      };
      if (id === "blank") button.classList.add("blank-design");
      const secondary = ["orbital", "whale", "terraces", "type"].includes(id);
      $(secondary ? "more-examples" : "example-gallery").append(button);
    }
  }
  function syncGallery() {
    for (const b of document.querySelectorAll("[data-example]"))
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.example === $("preset").value),
      );
  }
  $("preset").addEventListener("change", syncGallery);
  new MutationObserver(() => {
    if ($("new-dialog").open) {
      populateGallery();
      syncGallery();
    }
  }).observe($("new-dialog"), { attributes: true, attributeFilter: ["open"] });
  editor.subscribe((event) => {
    if (event.kind === "scene") refreshTextures();
  });
  return {
    openImage,
    refresh: refreshTextures,
    get revealing() {
      return revealing;
    },
    get scene() {
      return guideScene;
    },
    onView(view) {
      currentView = view;
      reveal(false);
      if (view !== "stereo") closeGuide();
    },
    reset() {
      closeGuide();
      gentle = null;
      $("guide-restore").hidden = true;
    },
  };
}
