import BpmnModdle from "bpmn-moddle";

/**
 * Emits explicit <bpmndi:BPMNLabel> child elements for gateway shapes and
 * sequence-flow edges that have a name. Without this pass, bpmn-js falls back
 * to its built-in placement, which puts gateway names directly under the
 * diamond (often on top of a vertical edge segment) and condition labels at
 * the edge midpoint (which lands on the collapsed trunk shared by multiple
 * branches of a split gateway).
 *
 *  - Gateway names: search 8 candidate slots around the gateway, pick the one
 *    with the fewest overlaps against edges and other shapes.
 *  - Sequence-flow names: anchor to the *last* horizontal segment of the
 *    waypoint chain (closest to the target) so the label appears where the
 *    branches have already separated, not in the collapsed trunk.
 */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Pt {
  x: number;
  y: number;
}

const EDGE_LABEL_OFFSET = 8;
const CHAR_W = 6;
const LABEL_H = 14;
const LABEL_PAD = 2;
// Cap label box width so long question labels wrap into multiple lines instead
// of stretching horizontally into adjacent shapes. Height grows with line count
// so the rendered text never overflows the computed bounds (which would land
// on top of the gateway diamond).
const MAX_LABEL_W = 110;
const LINE_H = 14;

const NON_BLOCKING_TYPES = new Set([
  "bpmn:Lane",
  "bpmn:Participant",
  "bpmn:TextAnnotation",
]);

export async function placeLabels(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const shapeBlockers: Bounds[] = [];
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNShape" || !el.bounds) continue;
    const type = el.bpmnElement?.$type as string | undefined;
    if (!type || NON_BLOCKING_TYPES.has(type)) continue;
    shapeBlockers.push(el.bounds);
  }

  const edgeSegments: Array<{ a: Pt; b: Pt }> = [];
  // Track which sides of each shape have an edge endpoint on them.
  // Used by gateway label placement to prefer a vertex without a line.
  const sideHits = new Map<string, Set<"top" | "right" | "bottom" | "left">>();
  const shapeBoundsById = new Map<string, Bounds>();
  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id && el.bounds) {
      shapeBoundsById.set(el.bpmnElement.id, el.bounds);
    }
  }
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNEdge") continue;
    const wp = el.waypoint ?? [];
    for (let i = 0; i < wp.length - 1; i++) {
      edgeSegments.push({ a: { x: wp[i].x, y: wp[i].y }, b: { x: wp[i + 1].x, y: wp[i + 1].y } });
    }
    const ref = el.bpmnElement;
    if (!ref) continue;
    const srcId = ref.sourceRef?.id;
    const tgtId = ref.targetRef?.id;
    if (srcId && wp.length > 0) recordSideHit(sideHits, shapeBoundsById, srcId, wp[0]);
    if (tgtId && wp.length > 0) recordSideHit(sideHits, shapeBoundsById, tgtId, wp[wp.length - 1]);
  }

  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape") {
      const type = el.bpmnElement?.$type as string | undefined;
      const name = el.bpmnElement?.name as string | undefined;
      if (!type || !type.endsWith("Gateway")) continue;
      if (!name || !name.trim()) continue;
      if (el.label) continue;
      const bounds = el.bounds;
      if (!bounds) continue;
      const id = el.bpmnElement.id as string | undefined;
      const usedSides = id ? sideHits.get(id) ?? new Set<"top" | "right" | "bottom" | "left">() : new Set<"top" | "right" | "bottom" | "left">();
      const labelBounds = pickGatewayLabelBounds(bounds, name, edgeSegments, shapeBlockers, usedSides);
      el.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", { ...labelBounds }),
      });
    } else if (el.$type === "bpmndi:BPMNEdge") {
      const ref = el.bpmnElement;
      if (!ref || ref.$type !== "bpmn:SequenceFlow") continue;
      const name = ref.name as string | undefined;
      if (!name || !name.trim()) continue;
      if (el.label) continue;
      const wp = el.waypoint ?? [];
      if (wp.length < 2) continue;
      const labelBounds = pickEdgeLabelBounds(wp, name, edgeSegments, shapeBlockers);
      if (!labelBounds) continue;
      el.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", { ...labelBounds }),
      });
    }
  }

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

type Side = "top" | "right" | "bottom" | "left";

function recordSideHit(
  map: Map<string, Set<Side>>,
  boundsById: Map<string, Bounds>,
  shapeId: string,
  point: Pt,
): void {
  const b = boundsById.get(shapeId);
  if (!b) return;
  const EPS = 2;
  let side: Side | null = null;
  if (Math.abs(point.x - b.x) <= EPS) side = "left";
  else if (Math.abs(point.x - (b.x + b.width)) <= EPS) side = "right";
  else if (Math.abs(point.y - b.y) <= EPS) side = "top";
  else if (Math.abs(point.y - (b.y + b.height)) <= EPS) side = "bottom";
  if (!side) return;
  let set = map.get(shapeId);
  if (!set) {
    set = new Set();
    map.set(shapeId, set);
  }
  set.add(side);
}

/**
 * Place the gateway's question label adjacent to a vertex of the diamond
 * that does NOT have an attached edge. The diamond has 4 vertices
 * (top/right/bottom/left). For each candidate side, compute the label bounds
 * just outside that vertex and score by (sideHasEdge ? big penalty) plus
 * collisions with edges/shapes. Prefer bottom > top > right > left when ties.
 */
function pickGatewayLabelBounds(
  gw: Bounds,
  name: string,
  edges: Array<{ a: Pt; b: Pt }>,
  shapes: Bounds[],
  usedSides: Set<Side>,
): Bounds {
  const naturalW = name.length * CHAR_W + 2 * LABEL_PAD;
  const w = Math.min(MAX_LABEL_W, Math.max(40, naturalW));
  // Estimate wrapped line count: bpmn-js wraps at word boundaries roughly when
  // the unwrapped width exceeds w. Use a conservative ceil so we always reserve
  // enough vertical space for the rendered text to stay inside `h`.
  const charsPerLine = Math.max(8, Math.floor((w - 2 * LABEL_PAD) / CHAR_W));
  const lineCount = Math.max(1, Math.ceil(name.length / charsPerLine));
  const h = lineCount * LINE_H + 2 * LABEL_PAD;
  const cx = gw.x + gw.width / 2;
  const cy = gw.y + gw.height / 2;
  const r = 6; // small offset from vertex
  const sideOrder: Side[] = ["bottom", "top", "right", "left"];
  const slotFor = (side: Side): Bounds => {
    switch (side) {
      case "bottom":
        return { x: cx - w / 2, y: gw.y + gw.height + r, width: w, height: h };
      case "top":
        return { x: cx - w / 2, y: gw.y - r - h, width: w, height: h };
      case "right":
        return { x: gw.x + gw.width + r, y: cy - h / 2, width: w, height: h };
      case "left":
        return { x: gw.x - r - w, y: cy - h / 2, width: w, height: h };
    }
  };

  const candidates: Array<{ rank: number; bounds: Bounds }> = [];
  for (let i = 0; i < sideOrder.length; i++) {
    const side = sideOrder[i];
    const b = slotFor(side);
    const sidePenalty = usedSides.has(side) ? 1000 : 0;
    const overlap = labelOverlapScore(b, edges, shapes, gw);
    const rank = sidePenalty + overlap * 100 + i;
    candidates.push({ rank, bounds: b });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return candidates[0].bounds;
}

function pickEdgeLabelBounds(
  wp: any[],
  name: string,
  edges: Array<{ a: Pt; b: Pt }>,
  shapes: Bounds[],
): Bounds | undefined {
  const w = Math.max(24, name.length * CHAR_W + 2 * LABEL_PAD);
  const h = LABEL_H + 2 * LABEL_PAD;
  let lastHIdx = -1;
  for (let i = wp.length - 2; i >= 0; i--) {
    if (Math.abs(wp[i].y - wp[i + 1].y) <= 1 && Math.abs(wp[i].x - wp[i + 1].x) > 8) {
      lastHIdx = i;
      break;
    }
  }
  let anchor: { ax: number; ay: number; horizontal: boolean };
  if (lastHIdx !== -1) {
    const a = wp[lastHIdx];
    const b = wp[lastHIdx + 1];
    const midX = (a.x + b.x) / 2;
    const targetX = (a.x + b.x) / 2 + (b.x - a.x) * 0.25;
    anchor = { ax: targetX || midX, ay: a.y, horizontal: true };
  } else {
    let lastVIdx = -1;
    for (let i = wp.length - 2; i >= 0; i--) {
      if (Math.abs(wp[i].x - wp[i + 1].x) <= 1 && Math.abs(wp[i].y - wp[i + 1].y) > 8) {
        lastVIdx = i;
        break;
      }
    }
    if (lastVIdx === -1) return undefined;
    const a = wp[lastVIdx];
    const b = wp[lastVIdx + 1];
    anchor = { ax: a.x, ay: (a.y + b.y) / 2 + (b.y - a.y) * 0.25, horizontal: false };
  }

  const candidates: Bounds[] = anchor.horizontal
    ? [
        { x: anchor.ax - w / 2, y: anchor.ay - h - EDGE_LABEL_OFFSET, width: w, height: h },
        { x: anchor.ax - w / 2, y: anchor.ay + EDGE_LABEL_OFFSET, width: w, height: h },
      ]
    : [
        { x: anchor.ax + EDGE_LABEL_OFFSET, y: anchor.ay - h / 2, width: w, height: h },
        { x: anchor.ax - w - EDGE_LABEL_OFFSET, y: anchor.ay - h / 2, width: w, height: h },
      ];

  let best: Bounds = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const s = labelOverlapScore(c, edges, shapes);
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

function labelOverlapScore(
  label: Bounds,
  edges: Array<{ a: Pt; b: Pt }>,
  shapes: Bounds[],
  exclude?: Bounds,
): number {
  let score = 0;
  for (const s of shapes) {
    if (exclude && s === exclude) continue;
    if (rectsIntersect(label, s)) score += 1;
  }
  for (const seg of edges) {
    if (segmentIntersectsRect(seg.a, seg.b, label)) score += 1;
  }
  return score;
}

function rectsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function segmentIntersectsRect(a: Pt, b: Pt, bounds: Bounds): boolean {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: Array<[number, number]> = [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 > t0;
}
