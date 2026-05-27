import BpmnModdle from "bpmn-moddle";

const DATA_REF_TYPES = new Set(["bpmn:DataObjectReference", "bpmn:DataStoreReference"]);
const ARTIFACT_TYPES = new Set([...DATA_REF_TYPES, "bpmn:TextAnnotation"]);
const CONTAINER_TYPES = new Set(["bpmn:Participant", "bpmn:Lane"]);

const HEADER_W = 30;
const DATA_W = 36;
const DATA_H = 50;
const STORE_W = 50;
const STORE_H = 50;
const ANNOTATION_W = 140;
const ANNOTATION_H = 40;
const ARTIFACT_GAP = 24;
const DEFAULT_SEARCH_STEP = 48;
const DEFAULT_SEARCH_RINGS = 4;
const DATA_SEARCH_STEP = 60;
const DATA_SEARCH_RINGS = 6;
const STORE_SEARCH_STEP = 68;
const STORE_SEARCH_RINGS = 7;
const PARTICIPANT_INSET = 12;
const CROWDED_MARGIN = 40;

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

interface EdgeSegment {
  a: Pt;
  b: Pt;
  edgeId: string;
}

interface ShapeNode {
  $type: "bpmndi:BPMNShape";
  id?: string;
  bpmnElement?: { id: string; $type: string };
  bounds?: Bounds;
}

interface EdgeNode {
  $type: "bpmndi:BPMNEdge";
  id?: string;
  bpmnElement?: { id: string; $type: string };
  waypoint?: Array<{ $type: string; x: number; y: number }>;
}

interface ArtifactGroup {
  artifact: any;
  associations: any[];
  attachedNodeIds: string[];
  participantId?: string;
}

interface ArtifactRoute {
  points: Pt[];
  bends: number;
  length: number;
  crossings: number;
}

interface ArtifactCandidate {
  bounds: Bounds;
  routes: Map<string, Pt[]>;
  insideParticipant: boolean;
  score: {
    crossings: number;
    bends: number;
    totalLength: number;
    crowding: number;
  };
}

type PlaneEl = ShapeNode | EdgeNode;

export async function placeArtifacts(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as { rootElements?: any[]; diagrams?: any[] };

  const planeElements = collectPlaneElements(defs);
  if (planeElements === undefined) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }

  const shapeById = new Map<string, ShapeNode>();
  const edgeById = new Map<string, EdgeNode>();
  const participantBoundsById = new Map<string, Bounds>();
  const blockingShapes: Array<{ id: string; bounds: Bounds }> = [];
  const controlEdgeSegments: EdgeSegment[] = [];

  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id && el.bounds) {
      const id = el.bpmnElement.id;
      shapeById.set(id, el);
      const type = el.bpmnElement.$type;
      if (type === "bpmn:Participant") {
        participantBoundsById.set(id, el.bounds);
      } else if (!ARTIFACT_TYPES.has(type) && !CONTAINER_TYPES.has(type)) {
        blockingShapes.push({ id, bounds: el.bounds });
      }
    } else if (el.$type === "bpmndi:BPMNEdge" && el.bpmnElement?.id) {
      edgeById.set(el.bpmnElement.id, el);
      if (el.bpmnElement.$type !== "bpmn:Association") {
        controlEdgeSegments.push(...edgeSegments(el.bpmnElement.id, el.waypoint ?? []));
      }
    }
  }

  const participantByElementId = collectParticipantMembership(defs);
  const artifactGroups = collectArtifactGroups(defs, participantByElementId);
  artifactGroups.sort(compareArtifactGroups);

  const pendingPlaneElements: PlaneEl[] = [];
  const placedArtifacts = new Map<string, Bounds>();

  for (const group of artifactGroups) {
    const connectedShapes = group.attachedNodeIds
      .map((id) => ({ id, bounds: shapeById.get(id)?.bounds }))
      .filter((entry): entry is { id: string; bounds: Bounds } => entry.bounds !== undefined);
    if (connectedShapes.length === 0) continue;

    const dims = artifactDims(group.artifact.$type);
    const participantBounds = group.participantId ? participantBoundsById.get(group.participantId) : undefined;
    const obstacleShapes = [
      ...blockingShapes,
      ...Array.from(placedArtifacts.entries()).map(([id, bounds]) => ({ id, bounds })),
    ];

    const candidateBounds = generateCandidateBounds(
      group.artifact.$type,
      dims,
      connectedShapes.map((shape) => shape.bounds),
      participantBounds,
    );

    let best: ArtifactCandidate | undefined;
    let relaxedBest: ArtifactCandidate | undefined;
    for (const bounds of candidateBounds) {
      const candidate = evaluateCandidate(
        bounds,
        group,
        connectedShapes,
        participantBounds,
        obstacleShapes,
        controlEdgeSegments,
      );
      if (!candidate) continue;
      if (candidate.insideParticipant) {
        if (!best || compareArtifactCandidates(candidate, best) < 0) best = candidate;
      } else if (!relaxedBest || compareArtifactCandidates(candidate, relaxedBest) < 0) {
        relaxedBest = candidate;
      }
    }

    const chosen = best ?? relaxedBest;
    if (!chosen) continue;

    placedArtifacts.set(group.artifact.id, chosen.bounds);
    upsertArtifactShape(moddle, shapeById, pendingPlaneElements, group.artifact, chosen.bounds);
    upsertAssociationEdges(moddle, edgeById, pendingPlaneElements, group.associations, chosen.routes);
  }

  appendPlaneElements(defs, pendingPlaneElements);

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

function collectPlaneElements(defs: any): PlaneEl[] | undefined {
  const dg = defs.diagrams?.[0];
  return dg?.plane?.planeElement;
}

function appendPlaneElements(defs: any, items: PlaneEl[]): void {
  const dg = defs.diagrams?.[0];
  if (!dg?.plane) return;
  if (!Array.isArray(dg.plane.planeElement)) dg.plane.planeElement = [];
  dg.plane.planeElement.push(...items);
}

function collectParticipantMembership(defs: any): Map<string, string> {
  const participantByElementId = new Map<string, string>();
  const processToParticipantId = new Map<string, string>();

  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Collaboration") continue;
    for (const participant of root.participants ?? []) {
      const processId = participant.processRef?.id;
      if (processId) processToParticipantId.set(processId, participant.id);
    }
  }

  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    const participantId = processToParticipantId.get(root.id);
    if (!participantId) continue;
    for (const flowElement of root.flowElements ?? []) {
      if (flowElement.id) participantByElementId.set(flowElement.id, participantId);
    }
    for (const artifact of root.artifacts ?? []) {
      if (artifact.id) participantByElementId.set(artifact.id, participantId);
    }
  }

  return participantByElementId;
}

function collectArtifactGroups(defs: any, participantByElementId: Map<string, string>): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();

  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    for (const association of root.artifacts ?? []) {
      if (association.$type !== "bpmn:Association") continue;
      const src = association.sourceRef;
      const tgt = association.targetRef;
      if (!src || !tgt) continue;
      const srcIsArtifact = ARTIFACT_TYPES.has(src.$type);
      const tgtIsArtifact = ARTIFACT_TYPES.has(tgt.$type);
      if (srcIsArtifact === tgtIsArtifact) continue;

      const artifact = srcIsArtifact ? src : tgt;
      const attached = srcIsArtifact ? tgt : src;
      const group = groups.get(artifact.id) ?? {
        artifact,
        associations: [],
        attachedNodeIds: [],
        participantId: participantByElementId.get(artifact.id) ?? participantByElementId.get(attached.id),
      };
      group.associations.push(association);
      if (!group.attachedNodeIds.includes(attached.id)) {
        group.attachedNodeIds.push(attached.id);
      }
      groups.set(artifact.id, group);
    }
  }

  return Array.from(groups.values());
}

function compareArtifactGroups(a: ArtifactGroup, b: ArtifactGroup): number {
  const aDims = artifactDims(a.artifact.$type);
  const bDims = artifactDims(b.artifact.$type);
  return (
    b.attachedNodeIds.length - a.attachedNodeIds.length ||
    bDims.width * bDims.height - aDims.width * aDims.height ||
    a.artifact.id.localeCompare(b.artifact.id)
  );
}

function searchConfigForArtifact(artifactType: string): { rings: number; step: number } {
  if (artifactType === "bpmn:DataStoreReference") {
    return { rings: STORE_SEARCH_RINGS, step: STORE_SEARCH_STEP };
  }
  if (artifactType === "bpmn:DataObjectReference") {
    return { rings: DATA_SEARCH_RINGS, step: DATA_SEARCH_STEP };
  }
  return { rings: DEFAULT_SEARCH_RINGS, step: DEFAULT_SEARCH_STEP };
}

function generateCandidateBounds(
  artifactType: string,
  dims: { width: number; height: number },
  attachedBounds: Bounds[],
  participantBounds: Bounds | undefined,
): Bounds[] {
  const anchor = unionBounds(attachedBounds);
  const anchorCenter = { x: centerX(anchor), y: centerY(anchor) };
  const candidates = new Map<string, Bounds>();
  const { rings, step } = searchConfigForArtifact(artifactType);

  const addCandidate = (x: number, y: number): void => {
    const bounds = {
      x: Math.round(x),
      y: Math.round(y),
      width: dims.width,
      height: dims.height,
    };
    const key = `${bounds.x},${bounds.y}`;
    if (!candidates.has(key)) candidates.set(key, bounds);
  };

  for (let ring = 0; ring <= rings; ring++) {
    const distance = ARTIFACT_GAP + ring * step;
    addCandidate(anchorCenter.x - dims.width / 2, anchor.y - dims.height - distance);
    addCandidate(anchorCenter.x - dims.width / 2, anchor.y + anchor.height + distance);
    addCandidate(anchor.x - dims.width - distance, anchorCenter.y - dims.height / 2);
    addCandidate(anchor.x + anchor.width + distance, anchorCenter.y - dims.height / 2);
    addCandidate(anchor.x - dims.width - distance, anchor.y - dims.height - distance);
    addCandidate(anchor.x + anchor.width + distance, anchor.y - dims.height - distance);
    addCandidate(anchor.x - dims.width - distance, anchor.y + anchor.height + distance);
    addCandidate(anchor.x + anchor.width + distance, anchor.y + anchor.height + distance);

    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        addCandidate(
          anchorCenter.x - dims.width / 2 + dx * step,
          anchorCenter.y - dims.height / 2 + dy * step,
        );
      }
    }
  }

  if (attachedBounds.length >= 2) {
    const centroid = averageCenter(attachedBounds);
    for (let ring = 0; ring <= rings; ring++) {
      const distance = ARTIFACT_GAP + ring * step;
      addCandidate(centroid.x - dims.width / 2, centroid.y - dims.height / 2 - distance);
      addCandidate(centroid.x - dims.width / 2, centroid.y - dims.height / 2 + distance);
      addCandidate(centroid.x - dims.width / 2 - distance, centroid.y - dims.height / 2);
      addCandidate(centroid.x - dims.width / 2 + distance, centroid.y - dims.height / 2);
    }
  }

  if (attachedBounds.length === 2) {
    const a = centerPoint(attachedBounds[0]);
    const b = centerPoint(attachedBounds[1]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const normal = { x: -dy / len, y: dx / len };
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let ring = 0; ring <= rings; ring++) {
      const distance = dims.height / 2 + ARTIFACT_GAP + ring * step;
      addCandidate(
        midpoint.x + normal.x * distance - dims.width / 2,
        midpoint.y + normal.y * distance - dims.height / 2,
      );
      addCandidate(
        midpoint.x - normal.x * distance - dims.width / 2,
        midpoint.y - normal.y * distance - dims.height / 2,
      );
    }
  }

  if (participantBounds) {
    addCandidate(participantBounds.x + HEADER_W + PARTICIPANT_INSET, anchorCenter.y - dims.height / 2);
    addCandidate(
      participantBounds.x + participantBounds.width - dims.width - PARTICIPANT_INSET,
      anchorCenter.y - dims.height / 2,
    );
    addCandidate(anchorCenter.x - dims.width / 2, participantBounds.y + PARTICIPANT_INSET);
    addCandidate(
      anchorCenter.x - dims.width / 2,
      participantBounds.y + participantBounds.height - dims.height - PARTICIPANT_INSET,
    );
  }

  return Array.from(candidates.values());
}

function evaluateCandidate(
  bounds: Bounds,
  group: ArtifactGroup,
  connectedShapes: Array<{ id: string; bounds: Bounds }>,
  participantBounds: Bounds | undefined,
  obstacleShapes: Array<{ id: string; bounds: Bounds }>,
  controlEdgeSegments: EdgeSegment[],
): ArtifactCandidate | undefined {
  const insideParticipant = participantBounds ? withinParticipantInterior(bounds, participantBounds) : true;
  if (participantBounds && !insideParticipant && farOutsideParticipant(bounds, participantBounds)) {
    return undefined;
  }

  if (obstacleShapes.some((shape) => boxesOverlap(bounds, shape.bounds, 4))) {
    return undefined;
  }
  if (controlEdgeSegments.some((segment) => segmentIntersectsRect(segment.a, segment.b, expandBounds(bounds, 4), 0))) {
    return undefined;
  }

  const routeBlockers = obstacleShapes;

  const routes = new Map<string, Pt[]>();
  let crossings = 0;
  let bends = 0;
  let totalLength = 0;

  for (const association of group.associations) {
    const otherId =
      association.sourceRef?.id === group.artifact.id
        ? association.targetRef?.id
        : association.sourceRef?.id;
    const otherShape = connectedShapes.find((shape) => shape.id === otherId);
    if (!otherShape) return undefined;

    const route = bestLeaderRoute(
      association.sourceRef?.id === group.artifact.id ? bounds : otherShape.bounds,
      association.sourceRef?.id === group.artifact.id ? otherShape.bounds : bounds,
      routeBlockers.filter((shape) => shape.id !== otherId),
    );
    routes.set(association.id, route.points);
    crossings += route.crossings;
    bends += route.bends;
    totalLength += route.length;
  }

  const crowding = routeBlockers.filter((shape) => boxesOverlap(expandBounds(bounds, CROWDED_MARGIN), shape.bounds, 0)).length;

  return {
    bounds,
    routes,
    insideParticipant,
    score: {
      crossings,
      bends,
      totalLength,
      crowding,
    },
  };
}

function compareArtifactCandidates(a: ArtifactCandidate, b: ArtifactCandidate): number {
  return (
    Number(b.insideParticipant) - Number(a.insideParticipant) ||
    a.score.crossings - b.score.crossings ||
    a.score.bends - b.score.bends ||
    a.score.crowding - b.score.crowding ||
    a.score.totalLength - b.score.totalLength ||
    a.bounds.y - b.bounds.y ||
    a.bounds.x - b.bounds.x
  );
}

function upsertArtifactShape(
  moddle: BpmnModdle,
  shapeById: Map<string, ShapeNode>,
  pending: PlaneEl[],
  artifact: any,
  bounds: Bounds,
): void {
  const existing = shapeById.get(artifact.id);
  if (existing) {
    existing.bounds = makeBounds(moddle, bounds);
    return;
  }
  const created = makeShape(moddle, artifact, bounds);
  shapeById.set(artifact.id, created);
  pending.push(created);
}

function upsertAssociationEdges(
  moddle: BpmnModdle,
  edgeById: Map<string, EdgeNode>,
  pending: PlaneEl[],
  associations: any[],
  routes: Map<string, Pt[]>,
): void {
  for (const association of associations) {
    const points = routes.get(association.id);
    if (!points) continue;
    const existing = edgeById.get(association.id);
    if (existing) {
      existing.waypoint = points.map((point) =>
        moddle.create("dc:Point", { x: point.x, y: point.y }) as unknown as { $type: string; x: number; y: number },
      );
      continue;
    }
    const created = makeEdge(moddle, association, points);
    edgeById.set(association.id, created);
    pending.push(created);
  }
}

function bestLeaderRoute(
  srcBounds: Bounds,
  tgtBounds: Bounds,
  obstacles: Array<{ id: string; bounds: Bounds }>,
): ArtifactRoute {
  const sourceSides = preferredLeaderSides(srcBounds, tgtBounds);
  const targetSides = preferredLeaderSides(tgtBounds, srcBounds);
  let best: ArtifactRoute | undefined;

  for (const sourceSide of sourceSides) {
    for (const targetSide of targetSides) {
      const start = portPoint(srcBounds, sourceSide);
      const end = portPoint(tgtBounds, targetSide);
      const routeCandidates = [
        [start, end],
        [start, { x: start.x, y: end.y }, end],
        [start, { x: end.x, y: start.y }, end],
      ];

      for (const rawRoute of routeCandidates) {
        const points = compactPoints(rawRoute);
        const route: ArtifactRoute = {
          points,
          bends: Math.max(0, points.length - 2),
          length: totalLength(points),
          crossings: countRouteCrossings(points, obstacles),
        };
        if (!best || compareRoutes(route, best) < 0) best = route;
      }
    }
  }

  return best ?? {
    points: [centerPoint(srcBounds), centerPoint(tgtBounds)],
    bends: 0,
    length: Math.hypot(centerX(tgtBounds) - centerX(srcBounds), centerY(tgtBounds) - centerY(srcBounds)),
    crossings: obstacles.length,
  };
}

function compareRoutes(a: ArtifactRoute, b: ArtifactRoute): number {
  return a.crossings - b.crossings || a.bends - b.bends || a.length - b.length || a.points.length - b.points.length;
}

function preferredLeaderSides(srcBounds: Bounds, tgtBounds: Bounds): Array<"left" | "right" | "top" | "bottom"> {
  const dx = centerX(tgtBounds) - centerX(srcBounds);
  const dy = centerY(tgtBounds) - centerY(srcBounds);

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "top", "bottom", "left"] : ["left", "top", "bottom", "right"];
  }
  return dy >= 0 ? ["bottom", "right", "left", "top"] : ["top", "right", "left", "bottom"];
}

function countRouteCrossings(points: Pt[], obstacles: Array<{ id: string; bounds: Bounds }>): number {
  let crossings = 0;
  for (const obstacle of obstacles) {
    let hit = false;
    for (let i = 0; i < points.length - 1; i++) {
      if (segmentIntersectsRect(points[i], points[i + 1], obstacle.bounds, 3)) {
        hit = true;
        break;
      }
    }
    if (hit) crossings++;
  }
  return crossings;
}

function withinParticipantInterior(bounds: Bounds, participant: Bounds): boolean {
  const left = participant.x + HEADER_W + PARTICIPANT_INSET;
  const right = participant.x + participant.width - PARTICIPANT_INSET;
  const top = participant.y + PARTICIPANT_INSET;
  const bottom = participant.y + participant.height - PARTICIPANT_INSET;
  return (
    bounds.x >= left &&
    bounds.y >= top &&
    bounds.x + bounds.width <= right &&
    bounds.y + bounds.height <= bottom
  );
}

function farOutsideParticipant(bounds: Bounds, participant: Bounds): boolean {
  const margin = STORE_SEARCH_STEP * 2;
  return (
    bounds.x + bounds.width < participant.x - margin ||
    bounds.x > participant.x + participant.width + margin ||
    bounds.y + bounds.height < participant.y - margin ||
    bounds.y > participant.y + participant.height + margin
  );
}

function unionBounds(items: Bounds[]): Bounds {
  return {
    x: Math.min(...items.map((item) => item.x)),
    y: Math.min(...items.map((item) => item.y)),
    width: Math.max(...items.map((item) => item.x + item.width)) - Math.min(...items.map((item) => item.x)),
    height: Math.max(...items.map((item) => item.y + item.height)) - Math.min(...items.map((item) => item.y)),
  };
}

function averageCenter(items: Bounds[]): Pt {
  return {
    x: items.reduce((sum, item) => sum + centerX(item), 0) / items.length,
    y: items.reduce((sum, item) => sum + centerY(item), 0) / items.length,
  };
}

function centerPoint(bounds: Bounds): Pt {
  return { x: centerX(bounds), y: centerY(bounds) };
}

function centerX(bounds: Bounds): number {
  return bounds.x + bounds.width / 2;
}

function centerY(bounds: Bounds): number {
  return bounds.y + bounds.height / 2;
}

function portPoint(bounds: Bounds, side: "left" | "right" | "top" | "bottom"): Pt {
  if (side === "left") return { x: bounds.x, y: centerY(bounds) };
  if (side === "right") return { x: bounds.x + bounds.width, y: centerY(bounds) };
  if (side === "top") return { x: centerX(bounds), y: bounds.y };
  return { x: centerX(bounds), y: bounds.y + bounds.height };
}

function boxesOverlap(a: Bounds, b: Bounds, pad: number): boolean {
  return !(
    a.x + a.width <= b.x + pad ||
    b.x + b.width <= a.x + pad ||
    a.y + a.height <= b.y + pad ||
    b.y + b.height <= a.y + pad
  );
}

function expandBounds(bounds: Bounds, by: number): Bounds {
  return {
    x: bounds.x - by,
    y: bounds.y - by,
    width: bounds.width + by * 2,
    height: bounds.height + by * 2,
  };
}

function segmentIntersectsRect(a: Pt, b: Pt, bounds: Bounds, inset: number): boolean {
  const left = bounds.x + inset;
  const right = bounds.x + bounds.width - inset;
  const top = bounds.y + inset;
  const bottom = bounds.y + bounds.height - inset;

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

function compactPoints(points: Pt[]): Pt[] {
  const deduped: Pt[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      deduped.push({ x: Math.round(point.x), y: Math.round(point.y) });
    }
  }
  return deduped;
}

function edgeSegments(edgeId: string, waypoint: Array<{ x: number; y: number }>): EdgeSegment[] {
  const segments: EdgeSegment[] = [];
  for (let i = 0; i < waypoint.length - 1; i++) {
    segments.push({
      edgeId,
      a: { x: waypoint[i].x, y: waypoint[i].y },
      b: { x: waypoint[i + 1].x, y: waypoint[i + 1].y },
    });
  }
  return segments;
}

function totalLength(points: Pt[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

function artifactDims($type: string): { width: number; height: number } {
  if ($type === "bpmn:DataStoreReference") return { width: STORE_W, height: STORE_H };
  if ($type === "bpmn:TextAnnotation") return { width: ANNOTATION_W, height: ANNOTATION_H };
  return { width: DATA_W, height: DATA_H };
}

function makeBounds(moddle: BpmnModdle, bounds: Bounds): Bounds {
  return moddle.create("dc:Bounds", { ...bounds }) as unknown as Bounds;
}

function makeShape(moddle: BpmnModdle, bpmnElement: any, bounds: Bounds): ShapeNode {
  return moddle.create("bpmndi:BPMNShape", {
    id: `${bpmnElement.id}_di`,
    bpmnElement,
    bounds: makeBounds(moddle, bounds),
  }) as unknown as ShapeNode;
}

function makeEdge(moddle: BpmnModdle, bpmnElement: any, waypoint: Pt[]): EdgeNode {
  return moddle.create("bpmndi:BPMNEdge", {
    id: `${bpmnElement.id}_di`,
    bpmnElement,
    waypoint: waypoint.map((point) =>
      moddle.create("dc:Point", { x: point.x, y: point.y }) as unknown as { $type: string; x: number; y: number },
    ),
  }) as unknown as EdgeNode;
}
