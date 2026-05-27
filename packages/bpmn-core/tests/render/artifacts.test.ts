import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import BpmnModdle from "bpmn-moddle";
import { layoutProcess } from "bpmn-auto-layout";
import { parseDsl, emitBpmnXml } from "../../src/dsl/index.js";
import { sanitizeForLayout } from "../../src/render/sanitize.js";
import { layoutMissingProcesses } from "../../src/render/layout-missing.js";
import { placePoolsAndLanes } from "../../src/render/pools.js";
import { placeArtifacts } from "../../src/render/artifacts.js";
import { orthogonalize } from "../../src/render/orthogonal.js";

const fixturesDir = resolvePath(__dirname, "..", "fixtures");
const ARTIFACT_TYPES = new Set(["bpmn:DataObjectReference", "bpmn:DataStoreReference", "bpmn:TextAnnotation"]);

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

async function fullPipeline(name: string): Promise<any> {
  const src = readFileSync(resolvePath(fixturesDir, name), "utf8");
  const r = parseDsl(src);
  const semantic = emitBpmnXml(r.model);
  const cleaned = await sanitizeForLayout(semantic);
  const laidOut = await layoutProcess(cleaned);
  const afterMissing = await layoutMissingProcesses(laidOut);
  const afterPools = await placePoolsAndLanes(afterMissing);
  const afterOrtho = await orthogonalize(afterPools);
  const xml = await placeArtifacts(afterOrtho);
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  return rootElement as any;
}

function planeElements(defs: any): any[] {
  return defs.diagrams?.[0]?.plane?.planeElement ?? [];
}

function artifactShapes(defs: any): any[] {
  return planeElements(defs).filter(
    (el) => el.$type === "bpmndi:BPMNShape" && ARTIFACT_TYPES.has(el.bpmnElement?.$type),
  );
}

function blockingShapes(defs: any): any[] {
  return planeElements(defs).filter(
    (el) =>
      el.$type === "bpmndi:BPMNShape" &&
      el.bpmnElement?.$type !== "bpmn:Participant" &&
      el.bpmnElement?.$type !== "bpmn:Lane" &&
      !ARTIFACT_TYPES.has(el.bpmnElement?.$type),
  );
}

function participantShapes(defs: any): any[] {
  return planeElements(defs).filter(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.$type === "bpmn:Participant",
  );
}

function associationEdges(defs: any): any[] {
  return planeElements(defs).filter(
    (el) => el.$type === "bpmndi:BPMNEdge" && el.bpmnElement?.$type === "bpmn:Association",
  );
}

function controlFlowEdges(defs: any): any[] {
  return planeElements(defs).filter(
    (el) => el.$type === "bpmndi:BPMNEdge" && el.bpmnElement?.$type !== "bpmn:Association",
  );
}

function edgesForArtifact(defs: any, artifactId: string): any[] {
  return associationEdges(defs).filter(
    (edge) =>
      edge.bpmnElement?.sourceRef?.id === artifactId ||
      edge.bpmnElement?.targetRef?.id === artifactId,
  );
}

function attachmentIds(edge: any, artifactId: string): string[] {
  const ids = [edge.bpmnElement?.sourceRef?.id, edge.bpmnElement?.targetRef?.id].filter(Boolean) as string[];
  return ids.filter((id) => id !== artifactId);
}

function shapeById(defs: any, id: string): any {
  return planeElements(defs).find(
    (el) => el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id === id,
  );
}

function center(bounds: Bounds): Pt {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boxesOverlap(a: Bounds, b: Bounds, pad = 0): boolean {
  return !(
    a.x + a.width <= b.x + pad ||
    b.x + b.width <= a.x + pad ||
    a.y + a.height <= b.y + pad ||
    b.y + b.height <= a.y + pad
  );
}

function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
  }
  return total;
}

function segmentIntersectsRect(a: Pt, b: Pt, bounds: Bounds, inset = 3): boolean {
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

function routeHitsBlockingShape(points: Pt[], blockers: any[]): boolean {
  return blockers.some((shape) =>
    points.some((_, i) => i < points.length - 1 && segmentIntersectsRect(points[i], points[i + 1], shape.bounds)),
  );
}

function boxHitsPolyline(bounds: Bounds, points: Pt[]): boolean {
  return points.some((_, i) => i < points.length - 1 && segmentIntersectsRect(points[i], points[i + 1], bounds, 0));
}

function isInsideAnyParticipant(bounds: Bounds, participants: any[]): boolean {
  return participants.some((participant) => {
    const p = participant.bounds as Bounds;
    return (
      bounds.x >= p.x &&
      bounds.y >= p.y &&
      bounds.x + bounds.width <= p.x + p.width &&
      bounds.y + bounds.height <= p.y + p.height
    );
  });
}

describe("M4.3 artifact-aware placement", () => {
  it("gemini-04 keeps repeated data objects and comments clear and local to the order flow", async () => {
    const defs = await fullPipeline("gemini-04.dsl");
    const artifacts = artifactShapes(defs);
    const blockers = blockingShapes(defs);

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(blockers.some((shape) => boxesOverlap(artifact.bounds, shape.bounds, 4)), artifact.bpmnElement?.name).toBe(false);
      const edges = edgesForArtifact(defs, artifact.bpmnElement.id);
      expect(edges.length, artifact.bpmnElement?.name).toBeGreaterThan(0);
      expect(Math.min(...edges.map((edge) => polylineLength(edge.waypoint))), artifact.bpmnElement?.name).toBeLessThanOrEqual(420);
      for (const edge of edges) {
        const edgeBlockers = blockers.filter((shape) => !attachmentIds(edge, artifact.bpmnElement.id).includes(shape.bpmnElement.id));
        expect(routeHitsBlockingShape(edge.waypoint, edgeBlockers), `${artifact.bpmnElement?.name} edge ${edge.bpmnElement?.id}`).toBe(false);
      }
    }
  });

  it("gemini-03 keeps text annotations off tasks/gateways and routes their leaders around flow nodes", async () => {
    const defs = await fullPipeline("gemini-03.dsl");
    const annotations = artifactShapes(defs).filter((shape) => shape.bpmnElement?.$type === "bpmn:TextAnnotation");
    const blockers = blockingShapes(defs);

    expect(annotations.length).toBeGreaterThan(0);
    for (const annotation of annotations) {
      expect(blockers.some((shape) => boxesOverlap(annotation.bounds, shape.bounds, 4)), annotation.bpmnElement?.id).toBe(false);
      const edges = edgesForArtifact(defs, annotation.bpmnElement.id);
      expect(edges.length, annotation.bpmnElement?.id).toBeGreaterThan(0);
      for (const edge of edges) {
        const edgeBlockers = blockers.filter((shape) => !attachmentIds(edge, annotation.bpmnElement.id).includes(shape.bpmnElement.id));
        expect(routeHitsBlockingShape(edge.waypoint, edgeBlockers), edge.bpmnElement?.id).toBe(false);
      }
    }
  });

  it("canon-5 keeps mixed data objects, stores, and comments readable inside the participant", async () => {
    const defs = await fullPipeline("canon-5-marriage.dsl");
    const artifacts = artifactShapes(defs);
    const blockers = blockingShapes(defs);
    const participants = participantShapes(defs);

    expect(artifacts.some((shape) => shape.bpmnElement?.$type === "bpmn:DataStoreReference")).toBe(true);
    expect(artifacts.some((shape) => shape.bpmnElement?.$type === "bpmn:TextAnnotation")).toBe(true);
    for (const artifact of artifacts) {
      expect(isInsideAnyParticipant(artifact.bounds, participants), artifact.bpmnElement?.name ?? artifact.bpmnElement?.id).toBe(true);
      expect(blockers.some((shape) => boxesOverlap(artifact.bounds, shape.bounds, 4)), artifact.bpmnElement?.name ?? artifact.bpmnElement?.id).toBe(false);
      for (const edge of edgesForArtifact(defs, artifact.bpmnElement.id)) {
        const edgeBlockers = blockers.filter((shape) => !attachmentIds(edge, artifact.bpmnElement.id).includes(shape.bpmnElement.id));
        expect(routeHitsBlockingShape(edge.waypoint, edgeBlockers), edge.bpmnElement?.id).toBe(false);
      }
    }
  });

  it("canon-2 keeps data objects clear in the narrow multi-lane layout", async () => {
    const defs = await fullPipeline("canon-2-incoming-flight.dsl");
    const dataArtifacts = artifactShapes(defs).filter((shape) => shape.bpmnElement?.$type !== "bpmn:TextAnnotation");
    const blockers = blockingShapes(defs);

    expect(dataArtifacts.length).toBeGreaterThan(0);
    for (const artifact of dataArtifacts) {
      expect(blockers.some((shape) => boxesOverlap(artifact.bounds, shape.bounds, 4)), artifact.bpmnElement?.name).toBe(false);
      const edges = edgesForArtifact(defs, artifact.bpmnElement.id);
      expect(Math.min(...edges.map((edge) => polylineLength(edge.waypoint))), artifact.bpmnElement?.name).toBeLessThanOrEqual(360);
      for (const edge of edges) {
        const edgeBlockers = blockers.filter((shape) => !attachmentIds(edge, artifact.bpmnElement.id).includes(shape.bpmnElement.id));
        expect(routeHitsBlockingShape(edge.waypoint, edgeBlockers), edge.bpmnElement?.id).toBe(false);
      }
    }
  });

  it("shared gemini-04 data objects stay near the centroid of all attached nodes", async () => {
    const defs = await fullPipeline("gemini-04.dsl");
    const dataArtifacts = artifactShapes(defs).filter((shape) => shape.bpmnElement?.$type === "bpmn:DataObjectReference");

    expect(dataArtifacts.length).toBeGreaterThan(0);
    for (const artifact of dataArtifacts) {
      const edges = edgesForArtifact(defs, artifact.bpmnElement.id);
      expect(edges.length, artifact.bpmnElement?.name).toBeGreaterThanOrEqual(2);
      const attachedCenters = edges
        .flatMap((edge) => attachmentIds(edge, artifact.bpmnElement.id))
        .map((id) => shapeById(defs, id))
        .filter(Boolean)
        .map((shape) => center(shape.bounds));
      const centroid = {
        x: attachedCenters.reduce((sum, point) => sum + point.x, 0) / attachedCenters.length,
        y: attachedCenters.reduce((sum, point) => sum + point.y, 0) / attachedCenters.length,
      };
      expect(distance(center(artifact.bounds), centroid), artifact.bpmnElement?.name).toBeLessThanOrEqual(260);
    }
  });

  it("canon-4 keeps Cured Compost and other artifacts off sequence-flow lines", async () => {
    const defs = await fullPipeline("canon-4-composting.dsl");
    const artifacts = artifactShapes(defs);
    const flowEdges = controlFlowEdges(defs);

    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(
        flowEdges.some((edge) => boxHitsPolyline(artifact.bounds, edge.waypoint)),
        artifact.bpmnElement?.name ?? artifact.bpmnElement?.id,
      ).toBe(false);
    }
  });
});
