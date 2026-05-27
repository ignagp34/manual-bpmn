import BpmnModdle from "bpmn-moddle";

/**
 * bpmn-auto-layout 0.5.0 explicitly does not lay out pools, lanes, or
 * message flows (its README lists them under "Limitations"). It produces
 * BPMNShapes for flow nodes laid out left-to-right but it does NOT respect
 * lane membership: tasks in the System lane and tasks in the Mechanic lane
 * end up on the same y row. Per spec / CLAUDE.md M4, lanes must form
 * horizontal strips and each task must sit in its own lane.
 *
 * This pass is the "snap to lane gridlines" step CLAUDE.md asks for:
 *
 * 1. **Lane row assignment.** Walk each participant's lanes in DSL
 *    declaration order. Compute `LANE_H` for each lane, assign a lane row
 *    y, and reposition every contained flow node's y to that row's
 *    centerline.
 * 2. **Participant + lane shapes.** Emit BPMNShapes wrapping the lanes
 *    (`isHorizontal=true`).
 * 3. **Participant stacking.** Multi-pool collaborations have each
 *    participant laid out at y≈0 by bpmn-auto-layout — shift each
 *    participant's contents down so the participants stack with `POOL_GAP`
 *    between them.
 * 4. **Edge shifts.** Every edge waypoint touched by a moved shape gets a
 *    matching dy. Cross-participant message flows interpolate along their
 *    waypoint chain; the orthogonal pass turns them into Manhattan
 *    elbows.
 * 5. **Message-flow seeding.** Generate a BPMNEdge with provisional
 *    straight waypoints for each `bpmn:messageFlow`.
 */

const HEADER_W = 30;       // left header strip on the participant
const POOL_PAD_X = 30;     // horizontal padding inside the participant
const LANE_PAD_Y = 20;     // vertical padding above/below contained shapes inside a lane
// Routing channel reserve at the top/bottom of each lane. Mirrors the orthogonal
// router's LANE_CHANNEL_INSET (18): activities are kept at least
// LANE_CHANNEL_INSET + EDGE_CHANNEL_RESERVE pixels from each lane edge so the
// router's preferred inset corridors land in whitespace instead of grazing
// activity tops/bottoms.
const EDGE_CHANNEL_RESERVE = 18;
const MIN_LANE_CLEARANCE = 12;
const MAX_CLEARANCE_NUDGE = 20;
const POOL_GAP = 60;       // vertical gap between stacked participants

interface Bounds { x: number; y: number; width: number; height: number; }

const ARTIFACT_LIKE_TYPES = new Set([
  "bpmn:DataObjectReference",
  "bpmn:DataStoreReference",
  "bpmn:TextAnnotation",
]);

export async function placePoolsAndLanes(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const shapeById = new Map<string, any>();
  const edgesById = new Map<string, any>();
  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id) {
      shapeById.set(el.bpmnElement.id, el);
    } else if (el.$type === "bpmndi:BPMNEdge" && el.bpmnElement?.id) {
      edgesById.set(el.bpmnElement.id, el);
    }
  }

  const processById = new Map<string, any>();
  let collaboration: any | undefined;
  for (const root of defs.rootElements ?? []) {
    if (root.$type === "bpmn:Process") processById.set(root.id, root);
    else if (root.$type === "bpmn:Collaboration") collaboration = root;
  }
  if (!collaboration) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }

  type Lane = { el: any; flowNodeIds: string[]; rowY?: number; rowH?: number; bounds?: Bounds };
  type Participant = {
    el: any;
    process: any;
    lanes: Lane[];
    /** Non-artifact shapes that define participant extents and edge shifts. */
    memberShapeIds: Set<string>;
    bounds?: Bounds;
  };

  const participants: Participant[] = [];
  for (const part of collaboration.participants ?? []) {
    const process = processById.get(part.processRef?.id);
    if (!process) continue;
    const lanes: Lane[] = [];
    for (const ls of process.laneSets ?? []) {
      for (const lane of ls.lanes ?? []) {
        const ids = (lane.flowNodeRef ?? []).map((r: any) => r.id).filter(Boolean) as string[];
        lanes.push({ el: lane, flowNodeIds: ids });
      }
    }
    const memberShapeIds = new Set<string>();
    for (const lane of lanes) for (const id of lane.flowNodeIds) memberShapeIds.add(id);
    for (const fe of process.flowElements ?? []) {
      if (fe.id && !ARTIFACT_LIKE_TYPES.has(fe.$type)) memberShapeIds.add(fe.id);
    }
    participants.push({ el: part, process, lanes, memberShapeIds });
  }

  // For shifting edges later: per-shape dy.
  const shapeDy = new Map<string, number>();

  let cursorY = 0;
  for (const p of participants) {
    // Filter out lanes with no shapes (e.g., a declared but unused lane).
    const lanesWithShapes = p.lanes.filter((ln) => ln.flowNodeIds.some((id) => shapeById.has(id)));

    // Find horizontal extent of the participant's contents.
    let minX = Infinity, maxX = -Infinity;
    for (const id of p.memberShapeIds) {
      const b = shapeById.get(id)?.bounds;
      if (!b) continue;
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x + b.width);
    }
    if (!isFinite(minX)) continue;

    // Lane height + relative offset preservation. bpmn-auto-layout often
    // produces a MULTI-ROW layout for one process (gemini-03's Employer lane
    // uses y={30, 45, 170, 185} for tasks/gateways spread across XOR
    // branches). Collapsing all contained shapes to a single row causes
    // horizontal collisions (a task at x=625 and a gateway at x=650 then
    // sit in the same lane row, overlapping). Instead, preserve the
    // original relative y offsets within the lane: shift the whole lane so
    // its top sits at `laneTop`, but keep each shape's offset from
    // `origMinY`.
    let laneTop = cursorY + LANE_PAD_Y;
    for (const lane of lanesWithShapes) {
      let origMinY = Infinity;
      let origMaxBottom = -Infinity;
      for (const id of lane.flowNodeIds) {
        const b = shapeById.get(id)?.bounds;
        if (!b) continue;
        origMinY = Math.min(origMinY, b.y);
        origMaxBottom = Math.max(origMaxBottom, b.y + b.height);
      }
      if (!isFinite(origMinY)) continue;
      const contentH = origMaxBottom - origMinY;
      const rowH = Math.max(
        80 + 2 * EDGE_CHANNEL_RESERVE,
        contentH + 2 * LANE_PAD_Y + 2 * EDGE_CHANNEL_RESERVE,
      );
      lane.rowY = laneTop;
      lane.rowH = rowH;
      const shiftToLaneTop = laneTop + LANE_PAD_Y + EDGE_CHANNEL_RESERVE - origMinY;
      for (const id of lane.flowNodeIds) {
        const shape = shapeById.get(id);
        if (!shape?.bounds) continue;
        shape.bounds.y += shiftToLaneTop;
        shapeDy.set(id, (shapeDy.get(id) ?? 0) + shiftToLaneTop);
      }
      applyLaneLocalClearanceNudges(lane, shapeById, shapeDy);
      laneTop += rowH;
    }

    // Shift non-lane flow nodes with the participant so cross-lane helper
    // shapes (for example, auto-layout fallbacks) stay aligned. Data objects
    // and text annotations are intentionally excluded here and are placed in
    // a dedicated pass once participant bounds are final.
    const flowDys: number[] = [];
    for (const lane of lanesWithShapes)
      for (const id of lane.flowNodeIds)
        flowDys.push(shapeDy.get(id) ?? 0);
    const avgDy = flowDys.length > 0
      ? Math.round(flowDys.reduce((a, b) => a + b, 0) / flowDys.length)
      : 0;
    for (const id of p.memberShapeIds) {
      if (shapeDy.has(id)) continue;
      const shape = shapeById.get(id);
      if (!shape?.bounds) continue;
      shape.bounds.y += avgDy;
      shapeDy.set(id, avgDy);
    }

    // Compute lane shape bounds spanning the participant interior.
    const interiorX = minX - POOL_PAD_X;
    const interiorW = maxX - minX + 2 * POOL_PAD_X;
    for (const lane of lanesWithShapes) {
      lane.bounds = {
        x: interiorX,
        y: lane.rowY!,
        width: interiorW,
        height: lane.rowH!,
      };
    }

    // Participant bounds wrap all lanes plus left header strip. If no lane has
    // any flow-node shape (degenerate fixture: e.g., s17-document-approval's
    // Review↔Revise cycle with no entry — bpmn-auto-layout's DFS never visits
    // either task), skip emitting the participant rather than producing NaN
    // bounds.
    if (lanesWithShapes.length === 0) continue;
    const firstLane = lanesWithShapes[0].bounds!;
    const lastLane = lanesWithShapes[lanesWithShapes.length - 1].bounds!;
    p.bounds = {
      x: interiorX - HEADER_W,
      y: firstLane.y - LANE_PAD_Y,
      width: interiorW + HEADER_W,
      height: lastLane.y + lastLane.height - firstLane.y + 2 * LANE_PAD_Y,
    };
    cursorY = p.bounds.y + p.bounds.height + POOL_GAP;
  }

  // Apply dy to every edge waypoint touched by a moved shape.
  for (const edge of edgesById.values()) {
    const ref = edge.bpmnElement;
    if (!ref) continue;
    const srcId = ref.sourceRef?.id;
    const tgtId = ref.targetRef?.id;
    const dySrc = srcId ? shapeDy.get(srcId) ?? 0 : 0;
    const dyTgt = tgtId ? shapeDy.get(tgtId) ?? 0 : 0;
    const wps = edge.waypoint ?? [];
    if (wps.length === 0) continue;
    if (dySrc === dyTgt) {
      for (const wp of wps) wp.y += dySrc;
    } else {
      for (let i = 0; i < wps.length; i++) {
        const t = wps.length === 1 ? 0 : i / (wps.length - 1);
        wps[i].y += Math.round(dySrc * (1 - t) + dyTgt * t);
      }
    }
  }

  // Emit participant + lane shapes (drawn first so they sit BEHIND flow nodes).
  const newShapes: any[] = [];
  for (const p of participants) {
    if (!p.bounds) continue;
    newShapes.push(
      moddle.create("bpmndi:BPMNShape", {
        id: `${p.el.id}_di`,
        bpmnElement: p.el,
        isHorizontal: true,
        bounds: moddle.create("dc:Bounds", { ...p.bounds }),
      }),
    );
    for (const lane of p.lanes) {
      if (!lane.bounds) continue;
      newShapes.push(
        moddle.create("bpmndi:BPMNShape", {
          id: `${lane.el.id}_di`,
          bpmnElement: lane.el,
          isHorizontal: true,
          bounds: moddle.create("dc:Bounds", { ...lane.bounds }),
        }),
      );
    }
  }

  // Message flows: provisional straight waypoints between shape centers.
  const newEdges: any[] = [];
  for (const mf of collaboration.messageFlows ?? []) {
    if (edgesById.has(mf.id)) continue;
    const src = shapeById.get(mf.sourceRef?.id)?.bounds;
    const tgt = shapeById.get(mf.targetRef?.id)?.bounds;
    if (!src || !tgt) continue;
    const srcPt = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
    const tgtPt = { x: tgt.x + tgt.width / 2, y: tgt.y + tgt.height / 2 };
    newEdges.push(
      moddle.create("bpmndi:BPMNEdge", {
        id: `${mf.id}_di`,
        bpmnElement: mf,
        waypoint: [moddle.create("dc:Point", srcPt), moddle.create("dc:Point", tgtPt)],
      }),
    );
  }

  dg.plane.planeElement = [...newShapes, ...planeElements, ...newEdges];

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

/**
 * Grow the outer lanes (and their participants) so that routing waypoints
 * that landed above the topmost lane or below the bottommost lane are
 * enclosed inside the pool. Interior lanes are untouched: a cross-lane
 * route between two middle lanes naturally falls inside a neighbouring
 * lane, which is acceptable. Only the open top/bottom edges of a pool
 * look unfinished when an edge floats outside them.
 */
const OUTER_EXTEND_MARGIN = 8;
export async function extendOuterLanes(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const processToParticipantId = new Map<string, string>();
  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Collaboration") continue;
    for (const part of root.participants ?? []) {
      const pid = part.processRef?.id;
      if (pid) processToParticipantId.set(pid, part.id);
    }
  }
  const participantByNodeId = new Map<string, string>();
  const participantLaneOrder = new Map<string, string[]>();
  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    const pid = processToParticipantId.get(root.id);
    if (!pid) continue;
    for (const fe of root.flowElements ?? []) {
      if (fe.id) participantByNodeId.set(fe.id, pid);
    }
    const laneIds: string[] = [];
    for (const ls of root.laneSets ?? []) {
      for (const lane of ls.lanes ?? []) {
        if (lane.id) laneIds.push(lane.id);
      }
    }
    participantLaneOrder.set(pid, laneIds);
  }

  type ShapeEntry = { el: any; bounds: any };
  const participantShape = new Map<string, ShapeEntry>();
  const laneShape = new Map<string, ShapeEntry>();
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNShape") continue;
    const type = el.bpmnElement?.$type as string | undefined;
    const id = el.bpmnElement?.id as string | undefined;
    if (!id || !el.bounds) continue;
    if (type === "bpmn:Participant") participantShape.set(id, { el, bounds: el.bounds });
    else if (type === "bpmn:Lane") laneShape.set(id, { el, bounds: el.bounds });
  }

  const minYByParticipant = new Map<string, number>();
  const maxYByParticipant = new Map<string, number>();
  for (const el of planeElements) {
    if (el.$type !== "bpmndi:BPMNEdge") continue;
    const ref = el.bpmnElement;
    if (!ref) continue;
    const wps = el.waypoint ?? [];
    if (wps.length === 0) continue;
    const srcPid = participantByNodeId.get(ref.sourceRef?.id);
    const tgtPid = participantByNodeId.get(ref.targetRef?.id);
    const pids = new Set<string>();
    if (srcPid) pids.add(srcPid);
    if (tgtPid) pids.add(tgtPid);
    if (pids.size === 0) continue;
    for (const wp of wps) {
      for (const pid of pids) {
        const cur = minYByParticipant.get(pid);
        if (cur === undefined || wp.y < cur) minYByParticipant.set(pid, wp.y);
        const curMax = maxYByParticipant.get(pid);
        if (curMax === undefined || wp.y > curMax) maxYByParticipant.set(pid, wp.y);
      }
    }
  }

  for (const [pid, pShape] of participantShape) {
    const pb = pShape.bounds;
    const minWpY = minYByParticipant.get(pid);
    const maxWpY = maxYByParticipant.get(pid);
    if (minWpY === undefined || maxWpY === undefined) continue;

    const wantTop = Math.min(pb.y, minWpY - OUTER_EXTEND_MARGIN);
    const wantBottom = Math.max(pb.y + pb.height, maxWpY + OUTER_EXTEND_MARGIN);
    const topDelta = pb.y - wantTop;
    const bottomDelta = wantBottom - (pb.y + pb.height);

    if (topDelta > 0) {
      pb.y -= topDelta;
      pb.height += topDelta;
      const laneIds = participantLaneOrder.get(pid) ?? [];
      const firstLane = laneIds.map((id) => laneShape.get(id)).find((s) => s !== undefined);
      if (firstLane) {
        firstLane.bounds.y -= topDelta;
        firstLane.bounds.height += topDelta;
      }
    }
    if (bottomDelta > 0) {
      pb.height += bottomDelta;
      const laneIds = participantLaneOrder.get(pid) ?? [];
      let lastLane: ShapeEntry | undefined;
      for (const id of laneIds) {
        const s = laneShape.get(id);
        if (s) lastLane = s;
      }
      if (lastLane) {
        lastLane.bounds.height += bottomDelta;
      }
    }
  }

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

function applyLaneLocalClearanceNudges(
  lane: { flowNodeIds: string[]; rowY?: number; rowH?: number },
  shapeById: Map<string, any>,
  shapeDy: Map<string, number>,
): void {
  if (lane.rowY === undefined || lane.rowH === undefined) return;
  const laneTop = lane.rowY;
  const laneBottom = lane.rowY + lane.rowH;

  for (const id of lane.flowNodeIds) {
    const shape = shapeById.get(id);
    const bounds = shape?.bounds;
    if (!bounds) continue;

    const topClearance = bounds.y - laneTop;
    const bottomClearance = laneBottom - (bounds.y + bounds.height);
    let nudge = 0;

    if (topClearance < MIN_LANE_CLEARANCE && bottomClearance > MIN_LANE_CLEARANCE) {
      nudge = Math.min(
        MAX_CLEARANCE_NUDGE,
        MIN_LANE_CLEARANCE - topClearance,
        bottomClearance - MIN_LANE_CLEARANCE,
      );
    } else if (bottomClearance < MIN_LANE_CLEARANCE && topClearance > MIN_LANE_CLEARANCE) {
      nudge = -Math.min(
        MAX_CLEARANCE_NUDGE,
        MIN_LANE_CLEARANCE - bottomClearance,
        topClearance - MIN_LANE_CLEARANCE,
      );
    }

    if (nudge === 0) continue;
    bounds.y += nudge;
    shapeDy.set(id, (shapeDy.get(id) ?? 0) + nudge);
  }
}
