import { layerBounds, layerLocalPoint, sampleLayerDepth } from "./scene.js";

const NS = "http://www.w3.org/2000/svg";
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const corners = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const handles = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];
const isInput = (target) =>
  target instanceof Element &&
  !!target.closest(
    "input,textarea,select,button,[contenteditable=true],[data-no-canvas]",
  );
function rotate(x, y, radians) {
  const c = Math.cos(radians),
    s = Math.sin(radians);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Direct manipulation, selection overlays and a resolution-independent viewport. */
export function createViewport({
  editor,
  stage,
  artboard,
  canvas,
  overlay,
  onRender = () => {},
  onTextEdit = () => {},
  onRequestEdit = () => {},
  onStrokeStart = () => {},
  onStrokeMove = () => {},
  onStrokeEnd = () => {},
  onStatus = () => {},
  onZoom = () => {},
  snapEnabled = () => false,
}) {
  let zoom = 1,
    panX = 0,
    panY = 0,
    fitted = true;
  let view = "relief",
    tool = "select",
    space = false,
    gesture = null,
    destroyed = false;
  const pointers = new Map();
  const disposers = [];
  let activeHandles = [];
  const dims = () => ({
    width: editor.state.document?.width || 1100,
    height: editor.state.document?.height || 660,
  });
  const selectedLayers = () => {
    const ids = new Set(editor.selectedIds);
    return editor.state.scene.layers.filter(
      (layer) => ids.has(layer.id) && !layer.locked && layer.visible !== false,
    );
  };
  const listen = (element, event, callback, options) => {
    element.addEventListener(event, callback, options);
    disposers.push(() => element.removeEventListener(event, callback, options));
  };
  stage.style.touchAction = "none";
  if (!stage.hasAttribute("tabindex")) stage.tabIndex = 0;
  Object.assign(artboard.style, {
    position: "absolute",
    transformOrigin: "top left",
  });
  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    overflow: "visible",
    pointerEvents: "none",
  });
  overlay.setAttribute("aria-hidden", "true");
  canvas.style.touchAction = "none";

  function pointFromClient(clientX, clientY) {
    const rect = artboard.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    };
  }
  function pixelPoint(event) {
    const p = pointFromClient(event.clientX, event.clientY),
      d = dims();
    return { x: p.x * d.width, y: p.y * d.height };
  }
  function frameFor(layers = selectedLayers()) {
    if (!layers.length) return null;
    const d = dims();
    if (layers.length === 1) {
      const b = layerBounds(layers[0], d.width, d.height);
      return {
        cx: b.x * d.width,
        cy: b.y * d.height,
        halfX: b.halfWidth * d.width,
        halfY: b.halfHeight * d.height,
        rotation: (b.rotation * Math.PI) / 180,
      };
    }
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const layer of layers) {
      const b = layerBounds(layer, d.width, d.height),
        angle = (b.rotation * Math.PI) / 180;
      for (const [sx, sy] of corners) {
        const p = rotate(
          sx * b.halfWidth * d.width,
          sy * b.halfHeight * d.height,
          angle,
        );
        left = Math.min(left, b.x * d.width + p.x);
        right = Math.max(right, b.x * d.width + p.x);
        top = Math.min(top, b.y * d.height + p.y);
        bottom = Math.max(bottom, b.y * d.height + p.y);
      }
    }
    return {
      cx: (left + right) / 2,
      cy: (top + bottom) / 2,
      halfX: (right - left) / 2,
      halfY: (bottom - top) / 2,
      rotation: 0,
    };
  }
  function framePoint(frame, x, y) {
    const point = rotate(x, y, frame.rotation);
    return { x: frame.cx + point.x, y: frame.cy + point.y };
  }
  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, String(value));
    return node;
  }
  function refresh() {
    if (destroyed) return;
    const d = dims();
    overlay.setAttribute("viewBox", `0 0 ${d.width} ${d.height}`);
    const nodes = [],
      accent = "var(--accent, #275e5a)";
    activeHandles = [];
    if (view !== "stereo" && tool !== "brush") {
      const frame = gesture?.displayFrame || frameFor();
      if (frame) {
        const points = corners.map(([x, y]) =>
          framePoint(frame, x * frame.halfX, y * frame.halfY),
        );
        nodes.push(
          svg("polygon", {
            points: points.map((p) => `${p.x},${p.y}`).join(" "),
            fill: "none",
            stroke: accent,
            "stroke-width": 1.2,
            "vector-effect": "non-scaling-stroke",
            class: "selection-outline",
          }),
        );
        if (tool === "select" && !space) {
          const side = 7 / zoom;
          for (const [sx, sy] of handles) {
            const p = framePoint(frame, sx * frame.halfX, sy * frame.halfY);
            activeHandles.push({ ...p, sx, sy, kind: "resize" });
            nodes.push(
              svg("rect", {
                x: p.x - side / 2,
                y: p.y - side / 2,
                width: side,
                height: side,
                fill: "var(--paper, #faf8f1)",
                stroke: accent,
                "stroke-width": 1.2,
                "vector-effect": "non-scaling-stroke",
                class: "selection-handle",
              }),
            );
          }
          const top = framePoint(frame, 0, -frame.halfY);
          const rotationHandle = framePoint(frame, 0, -frame.halfY - 28 / zoom);
          nodes.push(
            svg("line", {
              x1: top.x,
              y1: top.y,
              x2: rotationHandle.x,
              y2: rotationHandle.y,
              stroke: accent,
              "stroke-width": 1,
              "vector-effect": "non-scaling-stroke",
            }),
          );
          nodes.push(
            svg("circle", {
              cx: rotationHandle.x,
              cy: rotationHandle.y,
              r: 4 / zoom,
              fill: "var(--paper, #faf8f1)",
              stroke: accent,
              "stroke-width": 1.2,
              "vector-effect": "non-scaling-stroke",
              class: "selection-rotate",
            }),
          );
          activeHandles.push({ ...rotationHandle, kind: "rotate" });
        }
      }
      if (gesture?.kind === "marquee" && gesture.moved) {
        const { start, current } = gesture;
        nodes.push(
          svg("rect", {
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
            fill: accent,
            "fill-opacity": 0.06,
            stroke: accent,
            "stroke-width": 1,
            "stroke-dasharray": "4 3",
            "vector-effect": "non-scaling-stroke",
            class: "selection-marquee",
          }),
        );
      }
    }
    if (gesture?.guides)
      for (const guide of gesture.guides)
        nodes.push(
          svg("line", {
            x1: guide.axis === "x" ? guide.value : 0,
            x2: guide.axis === "x" ? guide.value : d.width,
            y1: guide.axis === "y" ? guide.value : 0,
            y2: guide.axis === "y" ? guide.value : d.height,
            stroke: accent,
            "stroke-width": 1,
            "stroke-dasharray": "4 4",
            "vector-effect": "non-scaling-stroke",
            class: "alignment-guide",
          }),
        );
    overlay.replaceChildren(...nodes);
  }
  function layout() {
    const d = dims(),
      width = stage.clientWidth,
      height = stage.clientHeight;
    if (fitted)
      zoom = Math.max(
        0.02,
        Math.min((width - 48) / d.width, (height - 64) / d.height),
      );
    const w = d.width * zoom,
      h = d.height * zoom;
    Object.assign(artboard.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${(width - w) / 2 + panX}px`,
      top: `${(height - h) / 2 + panY}px`,
    });
    refresh();
    onZoom(zoom);
  }
  function fit() {
    fitted = true;
    panX = panY = 0;
    layout();
  }
  function zoomBy(factor, clientPoint) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const bounds = stage.getBoundingClientRect();
    const x =
      clientPoint?.clientX ?? clientPoint?.x ?? bounds.left + bounds.width / 2;
    const y =
      clientPoint?.clientY ?? clientPoint?.y ?? bounds.top + bounds.height / 2;
    const anchor = pointFromClient(x, y),
      d = dims();
    zoom = clamp(zoom * factor, 0.02, 16);
    fitted = false;
    panX =
      x -
      bounds.left -
      stage.clientLeft -
      anchor.x * d.width * zoom -
      (stage.clientWidth - d.width * zoom) / 2;
    panY =
      y -
      bounds.top -
      stage.clientTop -
      anchor.y * d.height * zoom -
      (stage.clientHeight - d.height * zoom) / 2;
    layout();
  }
  function hit(point) {
    const d = dims();
    if (
      editor.state.scene.layers.some(
        (l) => l.operation && l.operation !== "union",
      )
    ) {
      let surface = 0,
        selected = null;
      for (const layer of editor.state.scene.layers) {
        if (layer.visible === false) continue;
        const value = sampleLayerDepth(
          layer,
          point.x / d.width,
          point.y / d.height,
          d.width,
          d.height,
        );
        const next =
          layer.operation === "subtract"
            ? Math.max(0, surface - value)
            : layer.operation === "intersect"
              ? Math.min(surface, value)
              : Math.max(surface, value);
        if (
          !layer.locked &&
          value > 0.003 &&
          (next !== surface ||
            (layer.operation !== "subtract" && value >= surface))
        )
          selected = layer;
        surface = next;
      }
      return selected;
    }
    let best = null,
      depth = 0.003;
    for (const layer of editor.state.scene.layers) {
      if (layer.locked || layer.visible === false) continue;
      const candidate = sampleLayerDepth(
        layer,
        point.x / d.width,
        point.y / d.height,
        d.width,
        d.height,
      );
      if (candidate >= depth) {
        depth = candidate;
        best = layer;
      }
    }
    return best;
  }
  function groupIds(layer) {
    return layer.groupId
      ? editor.state.scene.layers
          .filter(
            (candidate) =>
              candidate.groupId === layer.groupId &&
              !candidate.locked &&
              candidate.visible !== false,
          )
          .map((candidate) => candidate.id)
      : [layer.id];
  }
  function handleAt(point, pointerType = "mouse") {
    return activeHandles
      .slice()
      .reverse()
      .find(
        (handle) =>
          Math.hypot(handle.x - point.x, handle.y - point.y) <=
          (pointerType === "touch" ? 22 : pointerType === "pen" ? 15 : 10) /
            zoom,
      );
  }
  function capture(event) {
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* Pointer may have ended between dispatched events. */
    }
  }
  function startTransform(kind, point, event, handle) {
    const originals = selectedLayers();
    if (
      !originals.length ||
      !editor.begin(
        kind === "move"
          ? "Move objects"
          : kind === "rotate"
            ? "Rotate objects"
            : "Resize objects",
      )
    )
      return;
    if (kind === "move" && event.altKey) {
      try {
        editor.duplicateSelected({ offset: 0 });
      } catch (error) {
        editor.cancel();
        onStatus(error.message);
        return;
      }
    }
    const layers = selectedLayers(),
      frame = frameFor(layers),
      d = dims();
    gesture = {
      kind,
      start: point,
      pointerId: event.pointerId,
      screenX: event.clientX,
      screenY: event.clientY,
      frame,
      handle,
      moved: false,
      alt: event.altKey,
      originals: layers.map((layer) => ({
        id: layer.id,
        x: layer.x ?? 0.5,
        y: layer.y ?? 0.5,
        scaleX: layer.scaleX ?? 1,
        scaleY: layer.scaleY ?? 1,
        rotation: layer.rotation ?? 0,
      })),
    };
    if (kind === "move") {
      const selected = new Set(layers.map((l) => l.id));
      gesture.targets = {
        x: [0, d.width / 2, d.width],
        y: [0, d.height / 2, d.height],
      };
      for (const l of editor.state.scene.layers) {
        if (selected.has(l.id) || l.visible === false) continue;
        const b = layerBounds(l, d.width, d.height),
          a = (b.rotation * Math.PI) / 180;
        const hx =
          Math.abs(Math.cos(a)) * b.halfWidth * d.width +
          Math.abs(Math.sin(a)) * b.halfHeight * d.height;
        const hy =
          Math.abs(Math.sin(a)) * b.halfWidth * d.width +
          Math.abs(Math.cos(a)) * b.halfHeight * d.height;
        gesture.targets.x.push(
          b.x * d.width - hx,
          b.x * d.width,
          b.x * d.width + hx,
        );
        gesture.targets.y.push(
          b.y * d.height - hy,
          b.y * d.height,
          b.y * d.height + hy,
        );
      }
    }
    if (kind === "rotate")
      gesture.angle = Math.atan2(point.y - frame.cy, point.x - frame.cx);
    capture(event);
  }
  function cancel() {
    if (!gesture) return false;
    const old = gesture;
    gesture = null;
    if (["move", "resize", "rotate", "stroke"].includes(old.kind)) {
      editor.cancel();
      if (old.kind === "stroke") onStrokeEnd({ cancelled: true });
      onRender(false);
    } else if (old.kind === "marquee") editor.select(old.selection);
    refresh();
    return true;
  }
  function down(event) {
    if (isInput(event.target) || (event.button !== 0 && event.button !== 1))
      return;
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    });
    if (event.pointerType === "touch" && pointers.size === 2) {
      cancel();
      const [a, b] = [...pointers.values()],
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      gesture = {
        kind: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        zoom,
        anchor: pointFromClient(center.x, center.y),
      };
      capture(event);
      event.preventDefault();
      return;
    }
    if (gesture) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    const point = pixelPoint(event),
      d = dims();
    if (tool === "pan" || space || event.button === 1) {
      gesture = {
        kind: "pan",
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panX,
        panY,
      };
      stage.style.cursor = "grabbing";
      capture(event);
      return;
    }
    if (view === "stereo") {
      onRequestEdit();
      if (view === "stereo") return;
    }
    if (tool === "brush" || tool === "erase") {
      if (point.x < 0 || point.y < 0 || point.x > d.width || point.y > d.height)
        return;
      gesture = { kind: "stroke", pointerId: event.pointerId };
      capture(event);
      onStrokeStart({ x: point.x / d.width, y: point.y / d.height }, event);
      return;
    }
    const handle = handleAt(point, event.pointerType);
    if (handle) {
      startTransform(handle.kind, point, event, handle);
      return;
    }
    const layer = hit(point);
    if (layer) {
      const ids = groupIds(layer),
        selection = editor.selectedIds;
      if (event.shiftKey) {
        const set = new Set(selection),
          remove = ids.every((id) => set.has(id));
        for (const id of ids) remove ? set.delete(id) : set.add(id);
        editor.select([...set]);
        refresh();
        return;
      }
      if (!selection.includes(layer.id)) editor.select(ids);
      startTransform("move", point, event);
      refresh();
    } else {
      gesture = {
        kind: "marquee",
        pointerId: event.pointerId,
        start: point,
        current: point,
        screenX: event.clientX,
        screenY: event.clientY,
        moved: false,
        append: event.shiftKey,
        selection: editor.selectedIds,
      };
      capture(event);
      if (!event.shiftKey) editor.select([]);
      refresh();
    }
  }
  function move(event) {
    if (pointers.has(event.pointerId))
      pointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
      });
    if (!gesture) {
      if (isInput(event.target)) return;
      if (tool === "pan" || space) stage.style.cursor = "grab";
      else if (tool === "brush" || tool === "erase")
        stage.style.cursor = "crosshair";
      else {
        const h = handleAt(pixelPoint(event));
        stage.style.cursor =
          h?.kind === "rotate"
            ? "grab"
            : h
              ? h.sx === 0
                ? "ns-resize"
                : h.sy === 0
                  ? "ew-resize"
                  : h.sx === h.sy
                    ? "nwse-resize"
                    : "nesw-resize"
              : "default";
      }
      return;
    }
    if (gesture.kind === "pinch") {
      if (pointers.size !== 2) return;
      const [a, b] = [...pointers.values()],
        d = dims(),
        bounds = stage.getBoundingClientRect();
      zoom = clamp(
        (gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
          Math.max(1, gesture.distance),
        0.02,
        16,
      );
      fitted = false;
      panX =
        (a.x + b.x) / 2 -
        bounds.left -
        stage.clientLeft -
        gesture.anchor.x * d.width * zoom -
        (stage.clientWidth - d.width * zoom) / 2;
      panY =
        (a.y + b.y) / 2 -
        bounds.top -
        stage.clientTop -
        gesture.anchor.y * d.height * zoom -
        (stage.clientHeight - d.height * zoom) / 2;
      layout();
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    if (gesture.kind === "pan") {
      fitted = false;
      panX = gesture.panX + event.clientX - gesture.x;
      panY = gesture.panY + event.clientY - gesture.y;
      layout();
      return;
    }
    const point = pixelPoint(event),
      d = dims();
    if (gesture.kind === "stroke") {
      onStrokeMove({ x: point.x / d.width, y: point.y / d.height }, event);
      return;
    }
    if (
      !gesture.moved &&
      Math.hypot(
        event.clientX - gesture.screenX,
        event.clientY - gesture.screenY,
      ) < 3
    )
      return;
    gesture.moved = true;
    if (gesture.kind === "marquee") {
      gesture.current = point;
      const left = Math.min(point.x, gesture.start.x),
        right = Math.max(point.x, gesture.start.x);
      const top = Math.min(point.y, gesture.start.y),
        bottom = Math.max(point.y, gesture.start.y);
      const ids = new Set(gesture.append ? gesture.selection : []);
      for (const layer of editor.state.scene.layers) {
        if (layer.locked || layer.visible === false) continue;
        const b = frameFor([layer]),
          p = corners.map(([x, y]) => framePoint(b, x * b.halfX, y * b.halfY));
        if (
          Math.max(...p.map((v) => v.x)) >= left &&
          Math.min(...p.map((v) => v.x)) <= right &&
          Math.max(...p.map((v) => v.y)) >= top &&
          Math.min(...p.map((v) => v.y)) <= bottom
        )
          for (const id of groupIds(layer)) ids.add(id);
      }
      editor.select([...ids]);
      refresh();
      return;
    }
    const byId = new Map(
      editor.state.scene.layers.map((layer) => [layer.id, layer]),
    );
    if (gesture.kind === "move") {
      let dx = point.x - gesture.start.x,
        dy = point.y - gesture.start.y;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      if (event.shiftKey) horizontal ? (dy = 0) : (dx = 0);
      gesture.guides = [];
      if (snapEnabled()) {
        const f = gesture.frame,
          c = Math.abs(Math.cos(f.rotation)),
          sn = Math.abs(Math.sin(f.rotation));
        const hx = c * f.halfX + sn * f.halfY,
          hy = sn * f.halfX + c * f.halfY;
        const snap = (axis, points) => {
          let best = 6 / zoom,
            correction = 0,
            target;
          for (const value of gesture.targets[axis])
            for (const point of points)
              if (Math.abs(value - point) < best) {
                best = Math.abs(value - point);
                correction = value - point;
                target = value;
              }
          if (target !== undefined)
            gesture.guides.push({ axis, value: target });
          return correction;
        };
        if (!event.shiftKey || horizontal)
          dx += snap("x", [f.cx - hx + dx, f.cx + dx, f.cx + hx + dx]);
        if (!event.shiftKey || !horizontal)
          dy += snap("y", [f.cy - hy + dy, f.cy + dy, f.cy + hy + dy]);
      }
      dx = clamp(
        dx / d.width,
        Math.max(...gesture.originals.map((o) => -0.5 - o.x)),
        Math.min(...gesture.originals.map((o) => 1.5 - o.x)),
      );
      dy = clamp(
        dy / d.height,
        Math.max(...gesture.originals.map((o) => -0.5 - o.y)),
        Math.min(...gesture.originals.map((o) => 1.5 - o.y)),
      );
      for (const original of gesture.originals) {
        const layer = byId.get(original.id);
        if (!layer) continue;
        layer.x = original.x + dx;
        layer.y = original.y + dy;
      }
    } else if (gesture.kind === "rotate") {
      const f = gesture.frame;
      let delta = Math.atan2(point.y - f.cy, point.x - f.cx) - gesture.angle;
      if (event.shiftKey)
        delta = (Math.round(delta / (Math.PI / 12)) * Math.PI) / 12;
      const proposed = gesture.originals.map((original) => {
        const p = rotate(
          original.x * d.width - f.cx,
          original.y * d.height - f.cy,
          delta,
        );
        return {
          original,
          x: (f.cx + p.x) / d.width,
          y: (f.cy + p.y) / d.height,
        };
      });
      if (
        proposed.some((p) => p.x < -0.5 || p.x > 1.5 || p.y < -0.5 || p.y > 1.5)
      )
        return;
      for (const { original, x, y } of proposed) {
        const layer = byId.get(original.id);
        if (!layer) continue;
        layer.x = x;
        layer.y = y;
        layer.rotation =
          (((original.rotation + (delta * 180) / Math.PI) % 360) + 360) % 360;
      }
      gesture.displayFrame = { ...f, rotation: f.rotation + delta };
    } else if (gesture.kind === "resize") {
      const f = gesture.frame,
        h = gesture.handle;
      const local = rotate(point.x - f.cx, point.y - f.cy, -f.rotation);
      const ax = gesture.alt ? 0 : -h.sx * f.halfX,
        ay = gesture.alt ? 0 : -h.sy * f.halfY;
      let sx = h.sx
        ? clamp((local.x - ax) / (h.sx * f.halfX - ax || 1), 0.02, 50)
        : 1;
      let sy = h.sy
        ? clamp((local.y - ay) / (h.sy * f.halfY - ay || 1), 0.02, 50)
        : 1;
      if (event.shiftKey || gesture.originals.length > 1) {
        const uniform =
          h.sx && h.sy
            ? Math.abs(sx - 1) > Math.abs(sy - 1)
              ? sx
              : sy
            : h.sx
              ? sx
              : sy;
        sx = sy = uniform;
      }
      // Bound factors jointly, preserving a group's proportions at editor limits.
      const minX = Math.max(...gesture.originals.map((o) => 0.1 / o.scaleX));
      const maxX = Math.min(...gesture.originals.map((o) => 5 / o.scaleX));
      const minY = Math.max(...gesture.originals.map((o) => 0.1 / o.scaleY));
      const maxY = Math.min(...gesture.originals.map((o) => 5 / o.scaleY));
      if (event.shiftKey || gesture.originals.length > 1)
        sx = sy = clamp(sx, Math.max(minX, minY), Math.min(maxX, maxY));
      else {
        sx = clamp(sx, minX, maxX);
        sy = clamp(sy, minY, maxY);
      }
      const proposed = gesture.originals.map((original) => {
        const p = rotate(
          original.x * d.width - f.cx,
          original.y * d.height - f.cy,
          -f.rotation,
        );
        const moved = rotate(
          ax + (p.x - ax) * sx,
          ay + (p.y - ay) * sy,
          f.rotation,
        );
        return {
          original,
          x: (f.cx + moved.x) / d.width,
          y: (f.cy + moved.y) / d.height,
        };
      });
      if (
        proposed.some((p) => p.x < -0.5 || p.x > 1.5 || p.y < -0.5 || p.y > 1.5)
      )
        return;
      for (const { original, x, y } of proposed) {
        const layer = byId.get(original.id);
        if (!layer) continue;
        layer.x = x;
        layer.y = y;
        layer.scaleX = original.scaleX * sx;
        layer.scaleY = original.scaleY * sy;
      }
      const center = framePoint(f, ax * (1 - sx), ay * (1 - sy));
      gesture.displayFrame = {
        ...f,
        cx: center.x,
        cy: center.y,
        halfX: f.halfX * sx,
        halfY: f.halfY * sy,
      };
    }
    refresh();
    onRender(true);
  }
  function up(event) {
    pointers.delete(event.pointerId);
    if (!gesture) return;
    if (gesture.kind === "pinch") {
      if (pointers.size < 2) gesture = null;
      refresh();
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    const old = gesture;
    gesture = null;
    if (old.kind === "stroke") onStrokeEnd({ cancelled: false });
    else if (["move", "resize", "rotate"].includes(old.kind)) {
      editor.commit();
      onRender(false);
    }
    refresh();
    stage.style.cursor = tool === "pan" || space ? "grab" : "default";
  }
  function keydown(event) {
    if (isInput(event.target)) return;
    if (event.code === "Space") {
      event.preventDefault();
      space = true;
      stage.style.cursor = "grab";
      refresh();
    }
    if (event.key === "Escape" && gesture) {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
    if (event.key === "Enter") {
      const layer = selectedLayers();
      if (layer.length === 1 && layer[0].type === "text") {
        event.preventDefault();
        event.stopPropagation();
        onTextEdit(layer[0]);
      }
    }
  }
  listen(stage, "pointerdown", down);
  listen(stage, "pointermove", move);
  listen(stage, "pointerup", up);
  listen(stage, "pointercancel", (event) => {
    pointers.delete(event.pointerId);
    cancel();
  });
  listen(stage, "lostpointercapture", (event) => {
    if (gesture?.pointerId === event.pointerId) cancel();
  });
  listen(stage, "dblclick", (event) => {
    if (isInput(event.target) || tool !== "select" || space) return;
    const point = pixelPoint(event),
      d = dims();
    // Text editing includes the spaces between letters; ordinary object
    // selection still uses the exact rendered surface and its erased areas.
    const layer =
      hit(point) ||
      editor.state.scene.layers
        .slice()
        .reverse()
        .find((candidate) => {
          if (
            candidate.type !== "text" ||
            candidate.locked ||
            candidate.visible === false
          )
            return false;
          const { u, v } = layerLocalPoint(
            candidate,
            point.x / d.width,
            point.y / d.height,
            d.width,
            d.height,
          );
          return u >= 0 && u <= 1 && v >= 0 && v <= 1;
        });
    if (layer?.type === "text") {
      event.preventDefault();
      editor.select(layer.id);
      onTextEdit(layer);
    }
  });
  listen(stage, "keydown", keydown);
  listen(window, "keyup", (event) => {
    if (event.code === "Space") {
      space = false;
      stage.style.cursor = tool === "pan" ? "grab" : "default";
      refresh();
    }
  });
  listen(window, "blur", () => {
    space = false;
    pointers.clear();
    cancel();
  });
  listen(
    stage,
    "wheel",
    (event) => {
      if (isInput(event.target)) return;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        zoomBy(Math.exp(-clamp(event.deltaY, -350, 350) * 0.002), event);
      } else if (!fitted) {
        event.preventDefault();
        panX -= event.shiftKey ? event.deltaY : event.deltaX;
        panY -= event.shiftKey ? 0 : event.deltaY;
        layout();
      }
    },
    { passive: false },
  );
  listen(stage, "contextmenu", (event) => {
    if (!isInput(event.target)) event.preventDefault();
  });
  const observer = new ResizeObserver(layout);
  observer.observe(stage);
  const unsubscribe = editor.subscribe((event) => {
    if (event.kind === "scene") layout();
    else if (event.kind === "selection") refresh();
  });
  fit();
  return {
    setView(value) {
      view = value;
      refresh();
    },
    setTool(value) {
      cancel();
      tool = value === "move" ? "select" : value === "paint" ? "brush" : value;
      stage.dataset.tool = tool;
      stage.style.cursor =
        tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";
      refresh();
    },
    fit,
    zoomBy,
    get zoom() {
      return zoom;
    },
    refresh,
    cancel,
    pointFromClient,
    selectedBounds: () => frameFor(),
    destroy() {
      cancel();
      destroyed = true;
      observer.disconnect();
      unsubscribe();
      for (const dispose of disposers) dispose();
      overlay.replaceChildren();
    },
  };
}
