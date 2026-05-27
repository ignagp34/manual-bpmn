import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, it, expect } from "vitest";
import BpmnModdle from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";
import { parseDsl, emitBpmnXml } from "../../src/dsl/index.js";
import { sanitizeForLayout } from "../../src/render/sanitize.js";
import { layoutMissingProcesses } from "../../src/render/layout-missing.js";
import { placeArtifacts } from "../../src/render/artifacts.js";
import { placePoolsAndLanes } from "../../src/render/pools.js";
import { orthogonalize } from "../../src/render/orthogonal.js";

const fixturesDir = resolvePath(__dirname, "..", "fixtures");
const validFixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".dsl"))
  .sort();

async function fullPipeline(name: string): Promise<string> {
  const src = readFileSync(resolvePath(fixturesDir, name), "utf8");
  const r = parseDsl(src);
  const semantic = emitBpmnXml(r.model);
  const cleaned = await sanitizeForLayout(semantic);
  const laidOut = await layoutProcess(cleaned);
  const afterMissing = await layoutMissingProcesses(laidOut);
  const afterPools = await placePoolsAndLanes(afterMissing);
  const afterOrtho = await orthogonalize(afterPools);
  return placeArtifacts(afterOrtho);
}

async function loadDiagram(name: string): Promise<any> {
  const xml = await fullPipeline(name);
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  return rootElement as any;
}

function planeElements(defs: any): any[] {
  return defs.diagrams?.[0]?.plane?.planeElement ?? [];
}

function shapeByName(defs: any, name: string): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.name === name,
  );
}

function shapeById(defs: any, id: string): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id === id,
  );
}

function firstGatewayShape(defs: any): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.$type === "bpmn:ParallelGateway",
  );
}

function laneShapeByName(defs: any, name: string): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.$type === "bpmn:Lane" && el.bpmnElement?.name === name,
  );
}

function edgeByNames(defs: any, sourceName: string, targetName: string): any {
  return planeElements(defs).find(
    (el) =>
      el.$type === "bpmndi:BPMNEdge" &&
      (el.bpmnElement?.sourceRef?.name ?? "") === sourceName &&
      (el.bpmnElement?.targetRef?.name ?? "") === targetName,
  );
}

function edgeByIds(defs: any, sourceId: string, targetId: string): any {
  return planeElements(defs).find(
    (el) =>
      el.$type === "bpmndi:BPMNEdge" &&
      el.bpmnElement?.sourceRef?.id === sourceId &&
      el.bpmnElement?.targetRef?.id === targetId,
  );
}

function firstOutgoingEdge(defs: any, sourceName: string): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNEdge" && (el.bpmnElement?.sourceRef?.name ?? "") === sourceName,
  );
}

function portSideAtPoint(bounds: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }) {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;

  if (point.x === left) return "left";
  if (point.x === right) return "right";
  if (point.y === top) return "top";
  if (point.y === bottom) return "bottom";
  return "unknown";
}

function assertPortNormality(
  waypoints: Array<{ x: number; y: number }>,
  sourceSide: "left" | "right" | "top" | "bottom",
  targetSide: "left" | "right" | "top" | "bottom",
): void {
  const start = waypoints[0];
  const next = waypoints[1];
  const prev = waypoints[waypoints.length - 2];
  const end = waypoints[waypoints.length - 1];

  if (sourceSide === "left" || sourceSide === "right") {
    expect(next.y).toBe(start.y);
  } else {
    expect(next.x).toBe(start.x);
  }

  if (targetSide === "left" || targetSide === "right") {
    expect(prev.y).toBe(end.y);
  } else {
    expect(prev.x).toBe(end.x);
  }
}

function bendCount(waypoints: Array<{ x: number; y: number }>): number {
  let bends = 0;
  for (let i = 1; i < waypoints.length - 1; i++) {
    const prev = waypoints[i - 1];
    const cur = waypoints[i];
    const next = waypoints[i + 1];
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    if ((dx1 === 0 && dy2 === 0) || (dy1 === 0 && dx2 === 0)) bends++;
  }
  return bends;
}

function hasHorizontalBoundaryOverlap(
  waypoints: Array<{ x: number; y: number }>,
  boundaryY: number,
  minX: number,
  maxX: number,
): boolean {
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (a.y !== b.y) continue;
    if (Math.abs(a.y - boundaryY) > 4) continue;
    const segMinX = Math.min(a.x, b.x);
    const segMaxX = Math.max(a.x, b.x);
    if (Math.max(segMinX, minX) < Math.min(segMaxX, maxX)) {
      return true;
    }
  }
  return false;
}

function segmentHitsBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  const inset = 3;
  const left = bounds.x + inset;
  const right = bounds.x + bounds.width - inset;
  const top = bounds.y + inset;
  const bottom = bounds.y + bounds.height - inset;

  if (a.x === b.x) {
    const x = a.x;
    if (x <= left || x >= right) return false;
    return Math.max(0, Math.min(Math.max(a.y, b.y), bottom) - Math.max(Math.min(a.y, b.y), top)) > 0;
  }
  if (a.y === b.y) {
    const y = a.y;
    if (y <= top || y >= bottom) return false;
    return Math.max(0, Math.min(Math.max(a.x, b.x), right) - Math.max(Math.min(a.x, b.x), left)) > 0;
  }
  return true;
}

describe("M4 render pipeline - orthogonal property", () => {
  for (const name of validFixtures) {
    it(`${name}: every BPMNEdge waypoint segment is horizontal or vertical`, async () => {
      const xml = await fullPipeline(name);
      const moddle = new BpmnModdle();
      const { rootElement } = await moddle.fromXML(xml);
      const dg = (rootElement as any).diagrams?.[0];
      const planeEls = dg?.plane?.planeElement ?? [];
      const offending: string[] = [];
      for (const el of planeEls) {
        if (el.$type !== "bpmndi:BPMNEdge") continue;
        if (el.bpmnElement?.$type === "bpmn:Association") continue;
        const wps = el.waypoint ?? [];
        for (let i = 0; i < wps.length - 1; i++) {
          const dx = wps[i + 1].x - wps[i].x;
          const dy = wps[i + 1].y - wps[i].y;
          if (dx !== 0 && dy !== 0) {
            offending.push(`${el.bpmnElement?.id} segment ${i}`);
          }
        }
      }
      expect(offending).toEqual([]);
    });

    it(`${name}: every flow node has BPMNShape with finite bounds`, async () => {
      const xml = await fullPipeline(name);
      const moddle = new BpmnModdle();
      const { rootElement } = await moddle.fromXML(xml);
      const defs = rootElement as any;
      const dg = defs.diagrams?.[0];
      const planeEls = dg?.plane?.planeElement ?? [];
      for (const el of planeEls) {
        if (el.$type !== "bpmndi:BPMNShape") continue;
        const b = el.bounds;
        expect(Number.isFinite(b.x)).toBe(true);
        expect(Number.isFinite(b.y)).toBe(true);
        expect(b.width).toBeGreaterThan(0);
        expect(b.height).toBeGreaterThan(0);
      }
    });
  }
});

describe("M4 render pipeline - canon-1 spurious-start regression guard", () => {
  it("canon-1 emits exactly one start event (Cashier's Order Initiation)", async () => {
    const src = readFileSync(resolvePath(fixturesDir, "canon-1-cheeseburger.dsl"), "utf8");
    const { model } = parseDsl(src);
    const starts = Array.from(model.flowNodes.values()).filter((n) => n.kind === "startEvent");
    expect(starts).toHaveLength(1);
    expect(starts[0].label).toBe("Order Initiation");
  });
});

describe("M4.1 render pipeline - canon-1 routing heuristics", () => {
  it("canon-1 enters Input customer order from the top and exits it from the bottom", async () => {
    const defs = await loadDiagram("canon-1-cheeseburger.dsl");
    const inputShape = shapeByName(defs, "Input customer order");
    const incoming = edgeByNames(defs, "Order Initiation", "Input customer order");
    const outgoing = firstOutgoingEdge(defs, "Input customer order");
    const splitGateway = firstGatewayShape(defs);

    expect(inputShape).toBeDefined();
    expect(incoming).toBeDefined();
    expect(outgoing).toBeDefined();
    expect(splitGateway).toBeDefined();

    const inputBounds = inputShape.bounds;
    const incomingEnd = incoming.waypoint[incoming.waypoint.length - 1];
    const outgoingStart = outgoing.waypoint[0];
    const outgoingEnd = outgoing.waypoint[outgoing.waypoint.length - 1];
    const gatewayBounds = splitGateway.bounds;

    expect(incomingEnd.y).toBe(inputBounds.y);
    expect(outgoingStart.y).toBe(inputBounds.y + inputBounds.height);
    expect(outgoingEnd.x).toBe(gatewayBounds.x);
    expect(outgoingEnd.y).toBe(gatewayBounds.y + gatewayBounds.height / 2);
  });

  it("canon-1 routes into Grab top and bottom buns from the left with at most one bend", async () => {
    const defs = await loadDiagram("canon-1-cheeseburger.dsl");
    const bunsShape = shapeByName(defs, "Grab top and bottom buns");
    const edge = edgeByNames(defs, "", "Grab top and bottom buns");

    expect(bunsShape).toBeDefined();
    expect(edge).toBeDefined();

    const bunsBounds = bunsShape.bounds;
    const end = edge.waypoint[edge.waypoint.length - 1];

    expect(end.x).toBe(bunsBounds.x);
    expect(bendCount(edge.waypoint)).toBeLessThanOrEqual(1);
  });

  it("canon-1 keeps the expeditor branch off the lane boundary line", async () => {
    const defs = await loadDiagram("canon-1-cheeseburger.dsl");
    const edge = edgeByNames(defs, "", "Grab cup and start drink dispenser");
    const expeditorLane = laneShapeByName(defs, "Expeditor");

    expect(edge).toBeDefined();
    expect(expeditorLane).toBeDefined();

    expect(
      hasHorizontalBoundaryOverlap(
        edge.waypoint,
        expeditorLane.bounds.y,
        expeditorLane.bounds.x,
        expeditorLane.bounds.x + expeditorLane.bounds.width,
      ),
    ).toBe(false);
  });

  it("canon-1 routes the upper-right join out of the right side and into Grab wrapped cheeseburger from chute from the left", async () => {
    const defs = await loadDiagram("canon-1-cheeseburger.dsl");
    const joinName = "ParallelJoin_parallel_join_Assembler_Slide_sandwich_down_heated_chute_Exp";
    const joinShape = shapeById(defs, joinName);
    const wrappedShape = shapeByName(defs, "Grab wrapped cheeseburger from chute");
    const edge = edgeByIds(defs, joinName, "Task_Expeditor_Grab_wrapped_cheeseburger_from_chute");

    expect(joinShape).toBeDefined();
    expect(wrappedShape).toBeDefined();
    expect(edge).toBeDefined();

    expect(portSideAtPoint(joinShape.bounds, edge.waypoint[0])).toBe("right");
    expect(portSideAtPoint(wrappedShape.bounds, edge.waypoint[edge.waypoint.length - 1])).toBe("left");
    assertPortNormality(edge.waypoint, "right", "left");
  });

  it("canon-1 keeps the fries branch entering the upper-right join from the bottom on a different side than the outgoing branch", async () => {
    const defs = await loadDiagram("canon-1-cheeseburger.dsl");
    const joinName = "ParallelJoin_parallel_join_Assembler_Slide_sandwich_down_heated_chute_Exp";
    const joinShape = shapeById(defs, joinName);
    const incoming = edgeByIds(defs, "Task_Expeditor_Ensure_fresh_batch_of_fries_is_ready", joinName);
    const outgoing = edgeByIds(defs, joinName, "Task_Expeditor_Grab_wrapped_cheeseburger_from_chute");

    expect(joinShape).toBeDefined();
    expect(incoming).toBeDefined();
    expect(outgoing).toBeDefined();

    const incomingSide = portSideAtPoint(joinShape.bounds, incoming.waypoint[incoming.waypoint.length - 1]);
    const outgoingSide = portSideAtPoint(joinShape.bounds, outgoing.waypoint[0]);

    expect(incomingSide).toBe("bottom");
    expect(outgoingSide).not.toBe(incomingSide);
    assertPortNormality(incoming.waypoint, "right", "bottom");
  });
});

describe("M4.2 render pipeline - gemini-04 activity side separation", () => {
  it("gemini-04 keeps activity loopbacks off the same left-side anchor used by the incoming gateway branches", async () => {
    const defs = await loadDiagram("gemini-04.dsl");
    const cases = [
      {
        taskId: "Task_Builder_Reorder_cheapest_parts",
        taskName: "Reorder cheapest parts",
        incomingFlow: ["Gateway_Builder_Check_stock", "Task_Builder_Reorder_cheapest_parts"],
        outgoingFlow: ["Task_Builder_Reorder_cheapest_parts", "Merge_Builder_Build"],
      },
      {
        taskId: "Task_Builder_Reorder_fastest_parts",
        taskName: "Reorder fastest parts",
        incomingFlow: ["Gateway_Builder_Check_stock", "Task_Builder_Reorder_fastest_parts"],
        outgoingFlow: ["Task_Builder_Reorder_fastest_parts", "Merge_Builder_Build"],
      },
      {
        taskId: "Task_Builder_Complaint_email_to_friends",
        taskName: "Complaint email to friends",
        incomingFlow: ["Gateway_Builder_Check_stock", "Task_Builder_Complaint_email_to_friends"],
        outgoingFlow: ["Task_Builder_Complaint_email_to_friends", "Merge_Builder_Build"],
      },
    ] as const;

    for (const entry of cases) {
      const taskShape = shapeById(defs, entry.taskId);
      const incoming = edgeByIds(defs, entry.incomingFlow[0], entry.incomingFlow[1]);
      const outgoing = edgeByIds(defs, entry.outgoingFlow[0], entry.outgoingFlow[1]);

      expect(taskShape, entry.taskName).toBeDefined();
      expect(incoming, `${entry.taskName} incoming`).toBeDefined();
      expect(outgoing, `${entry.taskName} outgoing`).toBeDefined();

      const incomingSide = portSideAtPoint(taskShape.bounds, incoming.waypoint[incoming.waypoint.length - 1]);
      const outgoingSide = portSideAtPoint(taskShape.bounds, outgoing.waypoint[0]);

      expect(incomingSide, `${entry.taskName} incoming side`).toBe("left");
      expect(outgoingSide, `${entry.taskName} outgoing side`).toBe("bottom");
      expect(outgoingSide, `${entry.taskName} side reuse`).not.toBe(incomingSide);
      expect(outgoing.waypoint[1].x, `${entry.taskName} outgoing first segment x`).toBe(outgoing.waypoint[0].x);
    }
  });
});

describe("M4.4 render pipeline - canon-3 gateway loopback separation", () => {
  it("canon-3 routes the 'No' branch around the curing activities instead of through them", async () => {
    const defs = await loadDiagram("canon-3-conveyor-belt.dsl");
    const cureShape = shapeByName(defs, "Cure segment with pressure and heat");
    const advanceShape = shapeByName(defs, "Advance belt");
    const mergeShape = shapeById(defs, "Merge_Vulcanization_Cure_segment_with_pressure_and_heat");
    const noEdge = edgeByIds(
      defs,
      "Gateway_Advance_belt",
      "Merge_Vulcanization_Cure_segment_with_pressure_and_heat",
    );
    const mergeOutgoing = edgeByIds(
      defs,
      "Merge_Vulcanization_Cure_segment_with_pressure_and_heat",
      "Task_Vulcanization_Cure_segment_with_pressure_and_heat",
    );

    expect(cureShape).toBeDefined();
    expect(advanceShape).toBeDefined();
    expect(mergeShape).toBeDefined();
    expect(noEdge).toBeDefined();
    expect(mergeOutgoing).toBeDefined();
    expect(noEdge.waypoint.length).toBeGreaterThan(2);

    const incomingSide = portSideAtPoint(mergeShape.bounds, noEdge.waypoint[noEdge.waypoint.length - 1]);
    const outgoingSide = portSideAtPoint(mergeShape.bounds, mergeOutgoing.waypoint[0]);
    expect(incomingSide).not.toBe(outgoingSide);

    for (let i = 0; i < noEdge.waypoint.length - 1; i++) {
      expect(
        segmentHitsBox(noEdge.waypoint[i], noEdge.waypoint[i + 1], cureShape.bounds),
        `No branch segment ${i} hits cure task`,
      ).toBe(false);
      expect(
        segmentHitsBox(noEdge.waypoint[i], noEdge.waypoint[i + 1], advanceShape.bounds),
        `No branch segment ${i} hits advance task`,
      ).toBe(false);
    }
  });
});

describe("M4 render pipeline - gemini-05 boundary outgoing flow", () => {
  it("gemini-05's deadline boundary has an outgoing sequence flow to System: Issue fine", async () => {
    const src = readFileSync(resolvePath(fixturesDir, "gemini-05.dsl"), "utf8");
    const { model } = parseDsl(src);
    const boundary = Array.from(model.flowNodes.values()).find(
      (n) => n.kind === "boundaryEvent" && n.label.includes("30 days"),
    );
    expect(boundary).toBeDefined();
    const out = model.flows.find((f) => f.sourceId === boundary!.id);
    expect(out).toBeDefined();
    const target = model.flowNodes.get(out!.targetId);
    expect(target?.label).toBe("Issue fine");
  });

  it("gemini-05 layout pipeline does not throw", async () => {
    await expect(fullPipeline("gemini-05.dsl")).resolves.toMatch(/<\?xml/);
  });
});
