import BpmnModdle from "bpmn-moddle";

const ALIGN_EPS = 8;
const BOUNDARY_EPS = 4;
const EVENT_TOP_ENTRY_MAX_DX = 220;
const GRID = 10;
const LOOP_OFFSET = 40;
const LANE_CHANNEL_INSET = 18;
const MIN_EDGE_CLEARANCE = 10;

type PortSide = "left" | "right" | "top" | "bottom";

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

interface ShapeInfo {
  id: string;
  type: string;
  bounds: Bounds;
}

interface BoundaryLine {
  x1: number;
  x2: number;
  y: number;
}

interface SideUsageCounts {
  incoming: number;
  outgoing: number;
}

interface FlowCounts {
  incoming: number;
  outgoing: number;
}

interface RouteScore {
  shapeCrossings: number;
  bends: number;
  laneBoundaryOverlaps: number;
  activityClearancePenalty: number;
  directionPenalty: number;
  gatewayReusePenalty: number;
  totalLength: number;
}

interface RouteCandidate {
  kind: string;
  points: Pt[];
  sourceSide: PortSide;
  targetSide: PortSide;
  score: RouteScore;
}

interface RoutingContext {
  laneByNodeId: Map<string, string>;
  participantByNodeId: Map<string, string>;
  laneBoundsById: Map<string, Bounds>;
  participantBoundsById: Map<string, Bounds>;
  flowNodeShapes: ShapeInfo[];
  blockingShapes: ShapeInfo[];
  boundaryLines: BoundaryLine[];
  flowCounts: Map<string, FlowCounts>;
  sideUsage: Map<string, Record<PortSide, SideUsageCounts>>;
}

export async function orthogonalize(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const shapeById = new Map<string, ShapeInfo>();
  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id && el.bounds) {
      shapeById.set(el.bpmnElement.id, {
        id: el.bpmnElement.id,
        type: el.bpmnElement.$type as string,
        bounds: el.bounds as Bounds,
      });
    }
  }

  const ctx = buildRoutingContext(defs, shapeById);

  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNEdge") continue;
    const ref = el.bpmnElement;
    if (!ref) continue;
    const srcId = ref.sourceRef?.id;
    const tgtId = ref.targetRef?.id;
    if (!srcId || !tgtId) continue;
    const srcShape = shapeById.get(srcId);
    const tgtShape = shapeById.get(tgtId);
    if (!srcShape || !tgtShape) continue;

    const wp =
      ref.$type === "bpmn:SequenceFlow"
        ? routeSequenceFlow(ref, srcShape, tgtShape, ctx)
        : ref.$type === "bpmn:Association"
          ? routeAssociation(srcShape, tgtShape, ctx)
          : fallbackManhattanWaypoints(srcShape.bounds, tgtShape.bounds, ref.sourceRef.$type as string);
    el.waypoint = wp.map((p) => moddle.create("dc:Point", { x: p.x, y: p.y }));
  }

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

function buildRoutingContext(defs: any, shapeById: Map<string, ShapeInfo>): RoutingContext {
  const laneByNodeId = new Map<string, string>();
  const participantByNodeId = new Map<string, string>();
  const laneBoundsById = new Map<string, Bounds>();
  const participantBoundsById = new Map<string, Bounds>();
  const boundaryLines: BoundaryLine[] = [];
  const flowNodeShapes: ShapeInfo[] = [];
  const blockingShapes: ShapeInfo[] = [];
  const flowCounts = new Map<string, FlowCounts>();

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
    for (const laneSet of root.laneSets ?? []) {
      for (const lane of laneSet.lanes ?? []) {
        for (const node of lane.flowNodeRef ?? []) {
          laneByNodeId.set(node.id, lane.id);
          if (participantId) participantByNodeId.set(node.id, participantId);
        }
      }
    }
    if (participantId) {
      for (const fe of root.flowElements ?? []) {
        if (fe.id && !participantByNodeId.has(fe.id)) {
          participantByNodeId.set(fe.id, participantId);
        }
        if (fe.$type === "bpmn:SequenceFlow") {
          bumpFlowCount(flowCounts, fe.sourceRef?.id, "outgoing");
          bumpFlowCount(flowCounts, fe.targetRef?.id, "incoming");
        }
      }
    }
  }

  for (const shape of shapeById.values()) {
    if (shape.type === "bpmn:Lane") {
      laneBoundsById.set(shape.id, shape.bounds);
      boundaryLines.push({ x1: shape.bounds.x, x2: shape.bounds.x + shape.bounds.width, y: shape.bounds.y });
      boundaryLines.push({
        x1: shape.bounds.x,
        x2: shape.bounds.x + shape.bounds.width,
        y: shape.bounds.y + shape.bounds.height,
      });
      continue;
    }
    if (shape.type === "bpmn:Participant") {
      participantBoundsById.set(shape.id, shape.bounds);
      continue;
    }
    blockingShapes.push(shape);
    if (
      shape.type !== "bpmn:DataObjectReference" &&
      shape.type !== "bpmn:DataStoreReference" &&
      shape.type !== "bpmn:TextAnnotation"
    ) {
      flowNodeShapes.push(shape);
    }
  }

  return {
    laneByNodeId,
    participantByNodeId,
    laneBoundsById,
    participantBoundsById,
    flowNodeShapes,
    blockingShapes,
    boundaryLines,
    flowCounts,
    sideUsage: new Map<string, Record<PortSide, SideUsageCounts>>(),
  };
}

function routeSequenceFlow(ref: any, src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): Pt[] {
  const sourceSides = preferredSourceSides(src, tgt, ctx, ref.sourceRef.$type as string);
  const targetSides = preferredTargetSides(src, tgt, ctx);
  const candidates: RouteCandidate[] = [];
  const seen = new Set<string>();

  for (const sourceSide of sourceSides) {
    for (const targetSide of targetSides) {
      for (const candidate of generateCandidates(sourceSide, targetSide, src, tgt, ctx)) {
        const signature = serializeCandidate(candidate);
        if (seen.has(signature)) continue;
        seen.add(signature);
        candidate.score = scoreCandidate(candidate, src, tgt, ctx);
        candidates.push(candidate);
      }
    }
  }

  if (candidates.length === 0) {
    return fallbackManhattanWaypoints(src.bounds, tgt.bounds, ref.sourceRef.$type as string);
  }

  const nonColliding = candidates.filter((candidate) => !routeHitsOtherShapes(candidate.points, src.id, tgt.id, ctx));
  let pool = nonColliding.length > 0 ? nonColliding : candidates;
  pool = filterGatewayFacingCandidates(pool, src, tgt, ctx);
  pool = filterGatewaySideConflicts(pool, src, tgt, ctx);
  pool = filterGatewayLoopbackCandidates(pool, src, tgt, ctx);
  pool = filterActivitySideConflicts(pool, src, tgt, ctx);
  pool.sort(compareCandidates);
  const best = pool[0];
  updateSideUsage(ctx, src.id, best.sourceSide, "outgoing");
  updateSideUsage(ctx, tgt.id, best.targetSide, "incoming");
  return best.points;
}

function routeAssociation(src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): Pt[] {
  const sourceSides = preferredAssociationSides(src.bounds, tgt.bounds);
  const targetSides = preferredAssociationSides(tgt.bounds, src.bounds);
  let best:
    | {
        points: Pt[];
        crossings: number;
        bends: number;
        length: number;
      }
    | undefined;

  for (const sourceSide of sourceSides) {
    for (const targetSide of targetSides) {
      const start = portPoint(src.bounds, sourceSide);
      const end = portPoint(tgt.bounds, targetSide);
      const candidates = [
        [start, end],
        [start, { x: start.x, y: end.y }, end],
        [start, { x: end.x, y: start.y }, end],
      ];

      for (const raw of candidates) {
        const points = compactPoints(raw);
        const candidate = {
          points,
          crossings: countAssociationCrossings(points, src.id, tgt.id, ctx),
          bends: Math.max(0, points.length - 2),
          length: euclideanLength(points),
        };
        if (
          !best ||
          candidate.crossings < best.crossings ||
          (candidate.crossings === best.crossings && candidate.bends < best.bends) ||
          (candidate.crossings === best.crossings &&
            candidate.bends === best.bends &&
            candidate.length < best.length)
        ) {
          best = candidate;
        }
      }
    }
  }

  return best?.points ?? [centerPoint(src.bounds), centerPoint(tgt.bounds)];
}

function generateCandidates(
  sourceSide: PortSide,
  targetSide: PortSide,
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): RouteCandidate[] {
  const start = portPoint(src.bounds, sourceSide);
  const end = portPoint(tgt.bounds, targetSide);
  const candidates: RouteCandidate[] = [];
  const horizontalSource = isHorizontalSide(sourceSide);
  const horizontalTarget = isHorizontalSide(targetSide);
  const xOptions = xCorridors(start, end, src, tgt);
  const yOptions = yCorridors(start, end, src, tgt, ctx);

  if (horizontalSource === horizontalTarget) {
    if (horizontalSource && Math.abs(start.y - end.y) < ALIGN_EPS) {
      candidates.push(makeCandidate("straight-h", sourceSide, targetSide, [start, end]));
    } else if (!horizontalSource && Math.abs(start.x - end.x) < ALIGN_EPS) {
      candidates.push(makeCandidate("straight-v", sourceSide, targetSide, [start, end]));
    }
  }

  if (horizontalSource && horizontalTarget) {
    for (const midX of xOptions) {
      candidates.push(
        makeCandidate("hvh", sourceSide, targetSide, [
          start,
          { x: midX, y: start.y },
          { x: midX, y: end.y },
          end,
        ]),
      );
    }
  } else if (!horizontalSource && !horizontalTarget) {
    for (const midY of yOptions) {
      candidates.push(
        makeCandidate("vhv", sourceSide, targetSide, [
          start,
          { x: start.x, y: midY },
          { x: end.x, y: midY },
          end,
        ]),
      );
    }
  } else if (!horizontalSource && horizontalTarget) {
    candidates.push(makeCandidate("vh", sourceSide, targetSide, [start, { x: start.x, y: end.y }, end]));
    for (const midY of yOptions) {
      candidates.push(
        makeCandidate("vhh", sourceSide, targetSide, [
          start,
          { x: start.x, y: midY },
          { x: end.x, y: midY },
          end,
        ]),
      );
    }
  } else {
    candidates.push(makeCandidate("hv", sourceSide, targetSide, [start, { x: end.x, y: start.y }, end]));
    for (const midX of xOptions) {
      candidates.push(
        makeCandidate("hvv", sourceSide, targetSide, [
          start,
          { x: midX, y: start.y },
          { x: midX, y: end.y },
          end,
        ]),
      );
    }
  }

  const topY = snap(Math.min(src.bounds.y, tgt.bounds.y) - LOOP_OFFSET);
  candidates.push(
    makeCandidate("top-channel", sourceSide, targetSide, [
      start,
      { x: start.x, y: topY },
      { x: end.x, y: topY },
      end,
    ]),
  );

  const bottomY = snap(Math.max(src.bounds.y + src.bounds.height, tgt.bounds.y + tgt.bounds.height) + LOOP_OFFSET);
  candidates.push(
    makeCandidate("bottom-channel", sourceSide, targetSide, [
      start,
      { x: start.x, y: bottomY },
      { x: end.x, y: bottomY },
      end,
    ]),
  );

  if (!horizontalSource && horizontalTarget) {
    const loopY = sourceSide === "top" ? topY : bottomY;
    const approachX = targetSide === "left" ? snap(end.x - LOOP_OFFSET) : snap(end.x + LOOP_OFFSET);
    candidates.push(
      makeCandidate("vhhv-loop", sourceSide, targetSide, [
        start,
        { x: start.x, y: loopY },
        { x: approachX, y: loopY },
        { x: approachX, y: end.y },
        end,
      ]),
    );
  } else if (horizontalSource && !horizontalTarget) {
    const loopX = sourceSide === "left" ? snap(start.x - LOOP_OFFSET) : snap(start.x + LOOP_OFFSET);
    const channelY = targetSide === "top" ? topY : bottomY;
    candidates.push(
      makeCandidate("hvvh-loop", sourceSide, targetSide, [
        start,
        { x: loopX, y: start.y },
        { x: loopX, y: channelY },
        { x: end.x, y: channelY },
        end,
      ]),
    );
  }

  return candidates.filter((candidate) => routeMatchesPorts(candidate.points, sourceSide, targetSide));
}

function preferredSourceSides(
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
  srcType: string,
): PortSide[] {
  if (srcType === "bpmn:BoundaryEvent") {
    return ["bottom", "right", "left"];
  }

  const sameLane = sharedLane(src.id, tgt.id, ctx);
  const dx = centerX(tgt.bounds) - centerX(src.bounds);
  const dy = centerY(tgt.bounds) - centerY(src.bounds);
  const sides: PortSide[] = [];

  if (src.type.endsWith("Event") && dy > ALIGN_EPS && Math.abs(dx) <= EVENT_TOP_ENTRY_MAX_DX) {
    pushUnique(sides, dx >= 0 ? "right" : "left", "bottom", "top", "left", "right");
    return sides;
  }

  if (isGatewayType(src.type) && gatewayRole(src.id, ctx) === "split" && sameLane && dx < -ALIGN_EPS) {
    const preferredVertical = dy >= 0 ? "bottom" : "top";
    const secondaryVertical = preferredVertical === "bottom" ? "top" : "bottom";
    pushUnique(sides, preferredVertical, secondaryVertical, "left", "right");
    return sides;
  }

  if (isGatewayType(src.type) && prefersHorizontalGatewayPort(dx, dy)) {
    pushUnique(
      sides,
      dx >= 0 ? "right" : "left",
      dy >= 0 ? "bottom" : "top",
    );
    return sides;
  }

  if (sameLane && dx > ALIGN_EPS) {
    pushUnique(sides, "right", "bottom", "top", "left");
    return sides;
  }
  if (sameLane && dx < -ALIGN_EPS) {
    pushUnique(sides, "left", "top", "bottom", "right");
    return sides;
  }

  if (Math.abs(dy) >= Math.abs(dx) * 0.75) {
    pushUnique(sides, dy >= 0 ? "bottom" : "top");
  }
  if (Math.abs(dx) >= Math.abs(dy) * 0.75) {
    pushUnique(sides, dx >= 0 ? "right" : "left");
  }
  pushUnique(sides, dy >= 0 ? "bottom" : "top", dx >= 0 ? "right" : "left", "left", "right", "top", "bottom");
  return sides;
}

function preferredTargetSides(src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): PortSide[] {
  const sameLane = sharedLane(src.id, tgt.id, ctx);
  const dx = centerX(tgt.bounds) - centerX(src.bounds);
  const dy = centerY(tgt.bounds) - centerY(src.bounds);
  const sides: PortSide[] = [];

  if (src.type.endsWith("Event") && dy > ALIGN_EPS && Math.abs(dx) <= EVENT_TOP_ENTRY_MAX_DX) {
    pushUnique(sides, "top", dx >= 0 ? "left" : "right", "left", "right", "bottom");
    return sides;
  }

  if (isGatewayType(tgt.type) && gatewayRole(tgt.id, ctx) === "join" && sameLane && dx < -ALIGN_EPS) {
    const preferredVertical = dy >= 0 ? "bottom" : "top";
    const secondaryVertical = preferredVertical === "bottom" ? "top" : "bottom";
    pushUnique(sides, preferredVertical, secondaryVertical, "right", "left");
    return sides;
  }

  if (isGatewayType(tgt.type) && prefersHorizontalGatewayPort(dx, dy)) {
    pushUnique(
      sides,
      dx >= 0 ? "left" : "right",
      dy >= 0 ? "top" : "bottom",
    );
    return sides;
  }

  if (sameLane && dx > ALIGN_EPS) {
    pushUnique(sides, "left", "top", "bottom", "right");
    return sides;
  }
  if (sameLane && dx < -ALIGN_EPS) {
    pushUnique(sides, "right", "top", "bottom", "left");
    return sides;
  }

  if (Math.abs(dy) >= Math.abs(dx) * 0.75) {
    pushUnique(sides, dy >= 0 ? "top" : "bottom");
  }
  if (Math.abs(dx) >= Math.abs(dy) * 0.75) {
    pushUnique(sides, dx >= 0 ? "left" : "right");
  }
  pushUnique(sides, dy >= 0 ? "top" : "bottom", dx >= 0 ? "left" : "right", "left", "right", "top", "bottom");
  return sides;
}

function scoreCandidate(candidate: RouteCandidate, src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): RouteScore {
  return {
    shapeCrossings: countShapeCrossings(candidate.points, src.id, tgt.id, ctx),
    bends: bendCount(candidate.points),
    laneBoundaryOverlaps: horizontalBoundaryOverlaps(candidate.points, ctx.boundaryLines),
    activityClearancePenalty: activityClearancePenalty(candidate.points, src.id, tgt.id, ctx),
    directionPenalty: directionPenalty(candidate, src, tgt, ctx),
    gatewayReusePenalty: gatewayReusePenalty(candidate, src, tgt, ctx),
    totalLength: totalLength(candidate.points),
  };
}

/**
 * Penalize horizontal segments that graze (but do not intersect) the top or
 * bottom edges of other flow-node shapes. Strict intersections are handled by
 * countShapeCrossings; this targets the "looks too close" near-misses where a
 * route hugs an activity edge because the router was trying to dodge a lane
 * boundary.
 */
function activityClearancePenalty(points: Pt[], srcId: string, tgtId: string, ctx: RoutingContext): number {
  let penalty = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.y - b.y) > ALIGN_EPS) continue;
    const segY = a.y;
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    for (const shape of ctx.flowNodeShapes) {
      if (shape.id === srcId || shape.id === tgtId) continue;
      const top = shape.bounds.y;
      const bottom = shape.bounds.y + shape.bounds.height;
      const left = shape.bounds.x;
      const right = shape.bounds.x + shape.bounds.width;
      if (rangeOverlap(segMinX, segMaxX, left, right) <= 0) continue;
      const distTop = Math.abs(segY - top);
      const distBottom = Math.abs(segY - bottom);
      const nearest = Math.min(distTop, distBottom);
      if (nearest < MIN_EDGE_CLEARANCE && segY > top - MIN_EDGE_CLEARANCE && segY < bottom + MIN_EDGE_CLEARANCE) {
        penalty += MIN_EDGE_CLEARANCE - nearest;
      }
    }
  }
  return penalty;
}

function directionPenalty(candidate: RouteCandidate, src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): number {
  const dx = centerX(tgt.bounds) - centerX(src.bounds);
  const dy = centerY(tgt.bounds) - centerY(src.bounds);
  const sameLane = sharedLane(src.id, tgt.id, ctx);
  const expectedSource: PortSide[] = [];
  const expectedTarget: PortSide[] = [];

  if (src.type.endsWith("Event") && dy > ALIGN_EPS && Math.abs(dx) <= EVENT_TOP_ENTRY_MAX_DX) {
    pushUnique(expectedSource, dx >= 0 ? "right" : "left", "bottom");
    pushUnique(expectedTarget, "top", dx >= 0 ? "left" : "right");
    return sidePenalty(candidate.sourceSide, expectedSource) + sidePenalty(candidate.targetSide, expectedTarget);
  }

  if (isGatewayType(src.type) && prefersHorizontalGatewayPort(dx, dy)) {
    pushUnique(expectedSource, dx >= 0 ? "right" : "left", dy >= 0 ? "bottom" : "top");
  }
  if (isGatewayType(tgt.type) && prefersHorizontalGatewayPort(dx, dy)) {
    pushUnique(expectedTarget, dx >= 0 ? "left" : "right", dy >= 0 ? "top" : "bottom");
  }

  if (sameLane && dx > ALIGN_EPS) {
    pushUnique(expectedSource, "right", "bottom", "top");
    pushUnique(expectedTarget, "left", "top", "bottom");
  } else if (sameLane && dx < -ALIGN_EPS) {
    pushUnique(expectedSource, "left", "top", "bottom");
    pushUnique(expectedTarget, "right", "top", "bottom");
  } else {
    if (Math.abs(dy) >= Math.abs(dx) * 0.75) {
      pushUnique(expectedSource, dy >= 0 ? "bottom" : "top");
      pushUnique(expectedTarget, dy >= 0 ? "top" : "bottom");
    }
    if (Math.abs(dx) >= Math.abs(dy) * 0.75) {
      pushUnique(expectedSource, dx >= 0 ? "right" : "left");
      pushUnique(expectedTarget, dx >= 0 ? "left" : "right");
    }
  }

  return sidePenalty(candidate.sourceSide, expectedSource) + sidePenalty(candidate.targetSide, expectedTarget);
}

function gatewayReusePenalty(candidate: RouteCandidate, src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): number {
  let penalty = 0;

  if (isGatewayType(src.type)) {
    const usage = getSideUsage(ctx, src.id, candidate.sourceSide);
    penalty += usage.incoming * 2 + usage.outgoing;
  }
  if (isGatewayType(tgt.type)) {
    const usage = getSideUsage(ctx, tgt.id, candidate.targetSide);
    penalty += usage.outgoing * 2 + usage.incoming;
  }

  return penalty;
}

function horizontalBoundaryOverlaps(points: Pt[], boundaries: BoundaryLine[]): number {
  let overlaps = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (Math.abs(a.y - b.y) > ALIGN_EPS) continue;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    for (const boundary of boundaries) {
      if (Math.abs(a.y - boundary.y) > BOUNDARY_EPS) continue;
      if (rangeOverlap(minX, maxX, boundary.x1, boundary.x2) > GRID) {
        overlaps++;
      }
    }
  }
  return overlaps;
}

function routeHitsOtherShapes(points: Pt[], srcId: string, tgtId: string, ctx: RoutingContext): boolean {
  return countShapeCrossings(points, srcId, tgtId, ctx) > 0;
}

function countShapeCrossings(points: Pt[], srcId: string, tgtId: string, ctx: RoutingContext): number {
  let crossings = 0;
  for (const shape of ctx.flowNodeShapes) {
    if (shape.id === srcId || shape.id === tgtId) continue;
    for (let i = 0; i < points.length - 1; i++) {
      if (segmentHitsBox(points[i], points[i + 1], shape.bounds)) {
        crossings++;
        break;
      }
    }
  }
  return crossings;
}

function countAssociationCrossings(points: Pt[], srcId: string, tgtId: string, ctx: RoutingContext): number {
  let crossings = 0;
  for (const shape of ctx.blockingShapes) {
    if (shape.id === srcId || shape.id === tgtId) continue;
    for (let i = 0; i < points.length - 1; i++) {
      if (segmentIntersectsRect(points[i], points[i + 1], shape.bounds)) {
        crossings++;
        break;
      }
    }
  }
  return crossings;
}

function updateSideUsage(
  ctx: RoutingContext,
  nodeId: string,
  side: PortSide,
  direction: keyof SideUsageCounts,
): void {
  const usage = ensureUsageRecord(ctx.sideUsage, nodeId);
  usage[side][direction] += 1;
}

function getSideUsage(ctx: RoutingContext, nodeId: string, side: PortSide): SideUsageCounts {
  return ensureUsageRecord(ctx.sideUsage, nodeId)[side];
}

function ensureUsageRecord(
  map: Map<string, Record<PortSide, SideUsageCounts>>,
  nodeId: string,
): Record<PortSide, SideUsageCounts> {
  let usage = map.get(nodeId);
  if (!usage) {
    usage = {
      left: { incoming: 0, outgoing: 0 },
      right: { incoming: 0, outgoing: 0 },
      top: { incoming: 0, outgoing: 0 },
      bottom: { incoming: 0, outgoing: 0 },
    };
    map.set(nodeId, usage);
  }
  return usage;
}

function xCorridors(start: Pt, end: Pt, src: ShapeInfo, tgt: ShapeInfo): number[] {
  const candidates = new Set<number>();
  const gapMid = snap((start.x + end.x) / 2);
  candidates.add(gapMid);
  candidates.add(snap(Math.min(start.x, end.x) - LOOP_OFFSET));
  candidates.add(snap(Math.max(start.x, end.x) + LOOP_OFFSET));
  candidates.add(snap((src.bounds.x + src.bounds.width + tgt.bounds.x) / 2));
  candidates.add(snap((src.bounds.x + tgt.bounds.x + tgt.bounds.width) / 2));
  return Array.from(candidates);
}

function yCorridors(start: Pt, end: Pt, src: ShapeInfo, tgt: ShapeInfo, ctx: RoutingContext): number[] {
  const candidates = new Set<number>();
  const srcLane = laneBoundsFor(src.id, ctx);
  const tgtLane = laneBoundsFor(tgt.id, ctx);
  candidates.add(snap((start.y + end.y) / 2));
  candidates.add(snap(Math.min(start.y, end.y) - LOOP_OFFSET));
  candidates.add(snap(Math.max(start.y, end.y) + LOOP_OFFSET));
  if (srcLane) {
    candidates.add(snap(srcLane.y + LANE_CHANNEL_INSET));
    candidates.add(snap(srcLane.y + srcLane.height - LANE_CHANNEL_INSET));
    candidates.add(snap(srcLane.y + srcLane.height / 2));
  }
  if (tgtLane) {
    candidates.add(snap(tgtLane.y + LANE_CHANNEL_INSET));
    candidates.add(snap(tgtLane.y + tgtLane.height - LANE_CHANNEL_INSET));
    candidates.add(snap(tgtLane.y + tgtLane.height / 2));
  }
  return Array.from(candidates);
}

function laneBoundsFor(nodeId: string, ctx: RoutingContext): Bounds | undefined {
  const laneId = ctx.laneByNodeId.get(nodeId);
  return laneId ? ctx.laneBoundsById.get(laneId) : undefined;
}

function sharedLane(srcId: string, tgtId: string, ctx: RoutingContext): boolean {
  const srcLane = ctx.laneByNodeId.get(srcId);
  return srcLane !== undefined && srcLane === ctx.laneByNodeId.get(tgtId);
}

function makeCandidate(kind: string, sourceSide: PortSide, targetSide: PortSide, rawPoints: Pt[]): RouteCandidate {
  return {
    kind,
    sourceSide,
    targetSide,
    points: compactPoints(rawPoints),
    score: {
      shapeCrossings: Number.POSITIVE_INFINITY,
      bends: Number.POSITIVE_INFINITY,
      laneBoundaryOverlaps: Number.POSITIVE_INFINITY,
      activityClearancePenalty: Number.POSITIVE_INFINITY,
      directionPenalty: Number.POSITIVE_INFINITY,
      gatewayReusePenalty: Number.POSITIVE_INFINITY,
      totalLength: Number.POSITIVE_INFINITY,
    },
  };
}

function compareCandidates(a: RouteCandidate, b: RouteCandidate): number {
  return (
    a.score.shapeCrossings - b.score.shapeCrossings ||
    a.score.bends - b.score.bends ||
    a.score.laneBoundaryOverlaps - b.score.laneBoundaryOverlaps ||
    a.score.directionPenalty - b.score.directionPenalty ||
    a.score.gatewayReusePenalty - b.score.gatewayReusePenalty ||
    a.score.activityClearancePenalty - b.score.activityClearancePenalty ||
    a.score.totalLength - b.score.totalLength ||
    a.points.length - b.points.length ||
    a.kind.localeCompare(b.kind)
  );
}

function serializeCandidate(candidate: RouteCandidate): string {
  return `${candidate.sourceSide}:${candidate.targetSide}:${candidate.points
    .map((p) => `${p.x},${p.y}`)
    .join("|")}`;
}

function compactPoints(points: Pt[]): Pt[] {
  const deduped: Pt[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      deduped.push({ x: point.x, y: point.y });
    }
  }

  const compacted: Pt[] = [];
  for (const point of deduped) {
    compacted.push(point);
    while (compacted.length >= 3) {
      const a = compacted[compacted.length - 3];
      const b = compacted[compacted.length - 2];
      const c = compacted[compacted.length - 1];
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        compacted.splice(compacted.length - 2, 1);
      } else {
        break;
      }
    }
  }
  return compacted;
}

function routeMatchesPorts(points: Pt[], sourceSide: PortSide, targetSide: PortSide): boolean {
  if (points.length < 2) return false;
  const start = points[0];
  const next = points[1];
  const prev = points[points.length - 2];
  const end = points[points.length - 1];

  if (!leavesSidePerpendicularly(start, next, sourceSide)) return false;
  if (!entersSidePerpendicularly(prev, end, targetSide)) return false;

  return true;
}

function segmentHitsBox(a: Pt, b: Pt, bounds: Bounds): boolean {
  const inset = 3;
  const left = bounds.x + inset;
  const right = bounds.x + bounds.width - inset;
  const top = bounds.y + inset;
  const bottom = bounds.y + bounds.height - inset;

  if (a.x === b.x) {
    const x = a.x;
    if (x <= left || x >= right) return false;
    return rangeOverlap(Math.min(a.y, b.y), Math.max(a.y, b.y), top, bottom) > 0;
  }
  if (a.y === b.y) {
    const y = a.y;
    if (y <= top || y >= bottom) return false;
    return rangeOverlap(Math.min(a.x, b.x), Math.max(a.x, b.x), left, right) > 0;
  }
  return true;
}

function segmentIntersectsRect(a: Pt, b: Pt, bounds: Bounds): boolean {
  const inset = 3;
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

function bendCount(points: Pt[]): number {
  let bends = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    if ((dx1 === 0 && dy2 === 0) || (dy1 === 0 && dx2 === 0)) {
      bends++;
    }
  }
  return bends;
}

function totalLength(points: Pt[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
  }
  return total;
}

function euclideanLength(points: Pt[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

function sidePenalty(side: PortSide, preferred: PortSide[]): number {
  const idx = preferred.indexOf(side);
  return idx === -1 ? 2 : idx;
}

function gatewayRole(nodeId: string, ctx: RoutingContext): "split" | "join" | "mixed" | "plain" {
  const counts = ctx.flowCounts.get(nodeId);
  if (!counts) return "plain";
  if (counts.incoming > 1 && counts.outgoing === 1) return "join";
  if (counts.incoming === 1 && counts.outgoing > 1) return "split";
  if (counts.incoming > 1 || counts.outgoing > 1) return "mixed";
  return "plain";
}

function isGatewayType(type: string): boolean {
  return type.endsWith("Gateway");
}

function isActivityLikeType(type: string): boolean {
  return !isGatewayType(type) && !type.endsWith("Event");
}

function isHorizontalSide(side: PortSide): boolean {
  return side === "left" || side === "right";
}

function preferredAssociationSides(src: Bounds, tgt: Bounds): PortSide[] {
  const dx = centerX(tgt) - centerX(src);
  const dy = centerY(tgt) - centerY(src);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "top", "bottom", "left"] : ["left", "top", "bottom", "right"];
  }
  return dy >= 0 ? ["bottom", "right", "left", "top"] : ["top", "right", "left", "bottom"];
}

function prefersHorizontalGatewayPort(dx: number, dy: number): boolean {
  return Math.abs(dx) > ALIGN_EPS && Math.abs(dx) >= Math.abs(dy) * 1.1;
}

function leavesSidePerpendicularly(start: Pt, next: Pt, side: PortSide): boolean {
  if (side === "left") {
    return Math.abs(next.y - start.y) < ALIGN_EPS && next.x < start.x;
  }
  if (side === "right") {
    return Math.abs(next.y - start.y) < ALIGN_EPS && next.x > start.x;
  }
  if (side === "top") {
    return Math.abs(next.x - start.x) < ALIGN_EPS && next.y < start.y;
  }
  return Math.abs(next.x - start.x) < ALIGN_EPS && next.y > start.y;
}

function entersSidePerpendicularly(prev: Pt, end: Pt, side: PortSide): boolean {
  if (side === "left") {
    return Math.abs(prev.y - end.y) < ALIGN_EPS && prev.x < end.x;
  }
  if (side === "right") {
    return Math.abs(prev.y - end.y) < ALIGN_EPS && prev.x > end.x;
  }
  if (side === "top") {
    return Math.abs(prev.x - end.x) < ALIGN_EPS && prev.y < end.y;
  }
  return Math.abs(prev.x - end.x) < ALIGN_EPS && prev.y > end.y;
}

function filterGatewayFacingCandidates(
  candidates: RouteCandidate[],
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): RouteCandidate[] {
  let filtered = candidates;
  const dx = centerX(tgt.bounds) - centerX(src.bounds);

  if (isGatewayType(src.type) && gatewayRole(src.id, ctx) === "join" && Math.abs(dx) > ALIGN_EPS) {
    const preferredSide = dx >= 0 ? "right" : "left";
    const preferred = filtered.filter((candidate) => candidate.sourceSide === preferredSide);
    if (preferred.length > 0) filtered = preferred;

    if (!isGatewayType(tgt.type) && !tgt.type.endsWith("Event")) {
      const preferredTargetSide = dx >= 0 ? "left" : "right";
      const preferredTarget = filtered.filter((candidate) => candidate.targetSide === preferredTargetSide);
      if (preferredTarget.length > 0) filtered = preferredTarget;
    }
  }

  if (isGatewayType(tgt.type) && gatewayRole(tgt.id, ctx) === "split" && Math.abs(dx) > ALIGN_EPS) {
    const preferredSide = dx >= 0 ? "left" : "right";
    const preferred = filtered.filter((candidate) => candidate.targetSide === preferredSide);
    if (preferred.length > 0) filtered = preferred;
  }

  return filtered;
}

function filterGatewaySideConflicts(
  candidates: RouteCandidate[],
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): RouteCandidate[] {
  let filtered = candidates;

  if (isGatewayType(src.type)) {
    const outgoingOnFreshSide = filtered.filter((candidate) => getSideUsage(ctx, src.id, candidate.sourceSide).incoming === 0);
    if (outgoingOnFreshSide.length > 0) filtered = outgoingOnFreshSide;
  }

  if (isGatewayType(tgt.type)) {
    const incomingOnFreshSide = filtered.filter((candidate) => getSideUsage(ctx, tgt.id, candidate.targetSide).outgoing === 0);
    if (incomingOnFreshSide.length > 0) filtered = incomingOnFreshSide;
  }

  return filtered;
}

function filterGatewayLoopbackCandidates(
  candidates: RouteCandidate[],
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): RouteCandidate[] {
  if (!sharedLane(src.id, tgt.id, ctx)) return candidates;
  if (!isGatewayType(src.type) || !isGatewayType(tgt.type)) return candidates;

  const dx = centerX(tgt.bounds) - centerX(src.bounds);
  if (dx >= -ALIGN_EPS) return candidates;

  const fullyVertical = candidates.filter(
    (candidate) => !isHorizontalSide(candidate.sourceSide) && !isHorizontalSide(candidate.targetSide),
  );
  if (fullyVertical.length > 0) return fullyVertical;

  const targetVertical = candidates.filter(
    (candidate) => !isHorizontalSide(candidate.targetSide),
  );
  if (targetVertical.length > 0) return targetVertical;

  const sourceVertical = candidates.filter(
    (candidate) => !isHorizontalSide(candidate.sourceSide),
  );
  return sourceVertical.length > 0 ? sourceVertical : candidates;
}

function filterActivitySideConflicts(
  candidates: RouteCandidate[],
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): RouteCandidate[] {
  let filtered = candidates;

  if (isActivityLikeType(src.type) && hasAnySideUsage(ctx, src.id, "incoming")) {
    const outgoingOnFreshSide = filtered.filter((candidate) => getSideUsage(ctx, src.id, candidate.sourceSide).incoming === 0);
    if (outgoingOnFreshSide.length > 0) filtered = outgoingOnFreshSide;

    const preferredSeparatedSourceSide = preferredSeparatedActivitySourceSide(src, tgt, ctx);
    if (preferredSeparatedSourceSide) {
      const preferred = filtered.filter((candidate) => candidate.sourceSide === preferredSeparatedSourceSide);
      if (preferred.length > 0) filtered = preferred;
    }
  }

  if (isActivityLikeType(tgt.type) && hasAnySideUsage(ctx, tgt.id, "outgoing")) {
    const incomingOnFreshSide = filtered.filter((candidate) => getSideUsage(ctx, tgt.id, candidate.targetSide).outgoing === 0);
    if (incomingOnFreshSide.length > 0) filtered = incomingOnFreshSide;
  }

  return filtered;
}

function preferredSeparatedActivitySourceSide(
  src: ShapeInfo,
  tgt: ShapeInfo,
  ctx: RoutingContext,
): PortSide | undefined {
  if (!sharedLane(src.id, tgt.id, ctx)) return undefined;

  const dx = centerX(tgt.bounds) - centerX(src.bounds);
  if (dx < -ALIGN_EPS && getSideUsage(ctx, src.id, "left").incoming > 0) {
    return "bottom";
  }
  if (dx > ALIGN_EPS && getSideUsage(ctx, src.id, "right").incoming > 0) {
    return "bottom";
  }

  return undefined;
}

function hasAnySideUsage(ctx: RoutingContext, nodeId: string, direction: keyof SideUsageCounts): boolean {
  const usage = ensureUsageRecord(ctx.sideUsage, nodeId);
  return usage.left[direction] > 0 || usage.right[direction] > 0 || usage.top[direction] > 0 || usage.bottom[direction] > 0;
}

function bumpFlowCount(
  flowCounts: Map<string, FlowCounts>,
  nodeId: string | undefined,
  direction: keyof FlowCounts,
): void {
  if (!nodeId) return;
  let counts = flowCounts.get(nodeId);
  if (!counts) {
    counts = { incoming: 0, outgoing: 0 };
    flowCounts.set(nodeId, counts);
  }
  counts[direction] += 1;
}

function portPoint(bounds: Bounds, side: PortSide): Pt {
  const cx = centerX(bounds);
  const cy = centerY(bounds);
  if (side === "left") return { x: bounds.x, y: cy };
  if (side === "right") return { x: bounds.x + bounds.width, y: cy };
  if (side === "top") return { x: cx, y: bounds.y };
  return { x: cx, y: bounds.y + bounds.height };
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

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function rangeOverlap(minA: number, maxA: number, minB: number, maxB: number): number {
  return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
}

function pushUnique(target: PortSide[], ...sides: PortSide[]): void {
  for (const side of sides) {
    if (!target.includes(side)) target.push(side);
  }
}

function fallbackManhattanWaypoints(src: Bounds, tgt: Bounds, srcType: string): Pt[] {
  const sCx = centerX(src);
  const sCy = centerY(src);
  const tCx = centerX(tgt);
  const tCy = centerY(tgt);
  const sRight = src.x + src.width;
  const sTop = src.y;
  const sBottom = src.y + src.height;
  const tLeft = tgt.x;
  const tRight = tgt.x + tgt.width;
  const tTop = tgt.y;
  const tBottom = tgt.y + tgt.height;

  const isBoundary = srcType === "bpmn:BoundaryEvent";
  const sameRow = Math.abs(sCy - tCy) < ALIGN_EPS;
  const forward = tCx > sCx;
  const verticallyAligned = Math.abs(sCx - tCx) < ALIGN_EPS;

  if (isBoundary) {
    const start = { x: sCx, y: sBottom };
    if (Math.abs(sCx - tCx) < ALIGN_EPS) {
      return [start, { x: sCx, y: tTop }];
    }
    const midY = Math.max(sBottom + LOOP_OFFSET, tCy);
    const tgtEnter = forward ? tLeft : tRight;
    return compactPoints([start, { x: sCx, y: midY }, { x: tgtEnter, y: midY }]);
  }

  if (verticallyAligned && !sameRow) {
    const above = tCy < sCy;
    return [
      { x: sCx, y: above ? sTop : sBottom },
      { x: sCx, y: above ? tBottom : tTop },
    ];
  }

  if (sameRow && forward) {
    return [
      { x: sRight, y: sCy },
      { x: tLeft, y: sCy },
    ];
  }

  if (sameRow && !forward) {
    const upY = snap(sTop - LOOP_OFFSET);
    return compactPoints([
      { x: sCx, y: sTop },
      { x: sCx, y: upY },
      { x: tCx, y: upY },
      { x: tCx, y: tTop },
    ]);
  }

  if (forward) {
    const horizontalGap = tLeft - sRight;
    const verticalGap = Math.abs(sCy - tCy);
    if (horizontalGap < 200 && verticalGap < 100) {
      let midX = snap((sRight + tLeft) / 2);
      if (midX <= sRight) midX = sRight + GRID;
      if (midX >= tLeft) midX = tLeft - GRID;
      return compactPoints([
        { x: sRight, y: sCy },
        { x: midX, y: sCy },
        { x: midX, y: tCy },
        { x: tLeft, y: tCy },
      ]);
    }
    const tgtBelow = tCy > sCy;
    const channelY = tgtBelow ? snap((sBottom + tTop) / 2) : snap((sTop + tBottom) / 2);
    return compactPoints([
      { x: sCx, y: tgtBelow ? sBottom : sTop },
      { x: sCx, y: channelY },
      { x: tCx, y: channelY },
      { x: tCx, y: tgtBelow ? tTop : tBottom },
    ]);
  }

  const upY = snap(Math.min(sTop, tTop) - LOOP_OFFSET);
  return compactPoints([
    { x: sCx, y: sTop },
    { x: sCx, y: upY },
    { x: tCx, y: upY },
    { x: tCx, y: tTop },
  ]);
}
