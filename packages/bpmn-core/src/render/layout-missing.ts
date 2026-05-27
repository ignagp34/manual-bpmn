import BpmnModdle from "bpmn-moddle";

/**
 * bpmn-auto-layout 0.5.0's `Layouter.layoutProcess()` calls
 * `getProcess()` (returns the *first* process) and lays out only that one.
 * Every other process in a collaboration has its `<bpmn:process>` defined
 * but no `<bpmndi:BPMNShape>` for its flow nodes — they show up as ghosts
 * in bpmn-js. gemini-03 hits this with 4 participants/processes.
 *
 * This pass fills the gap with a deterministic horizontal-stride layout:
 * topologically sort the un-laid-out process's flow nodes, place them
 * left-to-right at a fixed row, attach boundary events to their host,
 * generate straight-line sequence-flow edges. The orthogonal pass turns
 * those into Manhattan elbows; the pools/lanes pass snaps each shape to
 * its lane row.
 */

const TASK_W = 100;
const TASK_H = 80;
const GATEWAY_W = 50;
const GATEWAY_H = 50;
const EVENT_W = 36;
const EVENT_H = 36;
const ROW_Y = 30;            // provisional row — overridden by pools.ts
const GAP_X = 50;
const START_X = 50;

interface Bounds { x: number; y: number; width: number; height: number; }

export async function layoutMissingProcesses(layoutXml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(layoutXml);
  const defs = rootElement as any;

  const dg = defs.diagrams?.[0];
  if (!dg?.plane) {
    return (await moddle.toXML(rootElement, { format: false })).xml;
  }
  const planeElements: any[] = Array.isArray(dg.plane.planeElement) ? dg.plane.planeElement : [];

  const shapeById = new Map<string, any>();
  const edgeById = new Map<string, any>();
  for (const el of planeElements) {
    if (el.$type === "bpmndi:BPMNShape" && el.bpmnElement?.id) shapeById.set(el.bpmnElement.id, el);
    else if (el.$type === "bpmndi:BPMNEdge" && el.bpmnElement?.id) edgeById.set(el.bpmnElement.id, el);
  }

  const newPlaneElements: any[] = [];

  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    const flowElements: any[] = root.flowElements ?? [];
    const flowNodes = flowElements.filter(
      (e: any) =>
        e.$type !== "bpmn:SequenceFlow" &&
        e.$type !== "bpmn:DataObject" /* DataObject (not Reference) is invisible */,
    );
    if (flowNodes.length === 0) continue;

    // Process is "missing" if AT LEAST ONE flow node lacks a shape.
    // bpmn-auto-layout's DFS only visits elements reachable from a start
    // event. A cyclic graph with no incoming-flow-free node (e.g.,
    // s17-document-approval's Review↔Revise loop) leaves both tasks
    // un-laid-out, so we can't simply gate on "every node missing".
    const missing = flowNodes.filter((n: any) => !shapeById.has(n.id));
    if (missing.length === 0) continue;
    // Filter to only the missing nodes for placement.
    flowNodes.length = 0;
    flowNodes.push(...missing);

    const order = topologicalOrder(flowNodes);
    let x = START_X;
    const placed: Array<{ el: any; bounds: Bounds }> = [];
    for (const node of order) {
      if (isBoundaryEvent(node)) continue; // placed near host
      const dims = dimsFor(node.$type);
      const bounds = { x, y: ROW_Y + (TASK_H - dims.height) / 2, width: dims.width, height: dims.height };
      const shape = moddle.create("bpmndi:BPMNShape", {
        id: `${node.id}_di`,
        bpmnElement: node,
        bounds: moddle.create("dc:Bounds", { ...bounds }),
      });
      newPlaneElements.push(shape);
      shapeById.set(node.id, shape);
      placed.push({ el: node, bounds });
      x += dims.width + GAP_X;
    }

    // Boundary events: attach to host's bottom-edge.
    for (const node of flowNodes) {
      if (!isBoundaryEvent(node)) continue;
      const host = shapeById.get(node.attachedToRef?.id);
      if (!host?.bounds) continue;
      const dims = dimsFor(node.$type);
      const bounds = {
        x: host.bounds.x + host.bounds.width - dims.width / 2 - 10,
        y: host.bounds.y + host.bounds.height - dims.height / 2,
        width: dims.width,
        height: dims.height,
      };
      const shape = moddle.create("bpmndi:BPMNShape", {
        id: `${node.id}_di`,
        bpmnElement: node,
        bounds: moddle.create("dc:Bounds", { ...bounds }),
      });
      newPlaneElements.push(shape);
      shapeById.set(node.id, shape);
    }

    // Sequence flows: straight horizontal between centers.
    for (const fe of flowElements) {
      if (fe.$type !== "bpmn:SequenceFlow") continue;
      if (edgeById.has(fe.id)) continue;
      const src = shapeById.get(fe.sourceRef?.id)?.bounds;
      const tgt = shapeById.get(fe.targetRef?.id)?.bounds;
      if (!src || !tgt) continue;
      const wp = [
        { x: src.x + src.width, y: src.y + src.height / 2 },
        { x: tgt.x, y: tgt.y + tgt.height / 2 },
      ];
      const edge = moddle.create("bpmndi:BPMNEdge", {
        id: `${fe.id}_di`,
        bpmnElement: fe,
        waypoint: wp.map((p) => moddle.create("dc:Point", p)),
      });
      newPlaneElements.push(edge);
      edgeById.set(fe.id, edge);
    }
  }

  if (newPlaneElements.length > 0) {
    dg.plane.planeElement = [...planeElements, ...newPlaneElements];
  }

  const { xml } = await moddle.toXML(rootElement, { format: false });
  return xml;
}

function dimsFor($type: string): { width: number; height: number } {
  if ($type.endsWith("Gateway")) return { width: GATEWAY_W, height: GATEWAY_H };
  if (
    $type === "bpmn:StartEvent" ||
    $type === "bpmn:EndEvent" ||
    $type === "bpmn:IntermediateCatchEvent" ||
    $type === "bpmn:IntermediateThrowEvent" ||
    $type === "bpmn:BoundaryEvent"
  ) {
    return { width: EVENT_W, height: EVENT_H };
  }
  if ($type === "bpmn:DataObjectReference") return { width: 36, height: 50 };
  if ($type === "bpmn:DataStoreReference") return { width: 50, height: 50 };
  return { width: TASK_W, height: TASK_H };
}

function isBoundaryEvent(el: any): boolean {
  return el.$type === "bpmn:BoundaryEvent";
}

/** Topologically sort flow nodes by sequence-flow successors. Cycles are
 * broken arbitrarily by visiting the smallest-id element first. */
function topologicalOrder(flowNodes: any[]): any[] {
  const incoming = new Map<string, number>();
  const succs = new Map<string, string[]>();
  const byId = new Map<string, any>();
  for (const fe of flowNodes) {
    byId.set(fe.id, fe);
    incoming.set(fe.id, 0);
    succs.set(fe.id, []);
  }
  for (const fe of flowNodes) {
    for (const out of fe.outgoing ?? []) {
      const tgt = out.targetRef?.id;
      if (!tgt || !byId.has(tgt)) continue;
      succs.get(fe.id)!.push(tgt);
      incoming.set(tgt, (incoming.get(tgt) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, n] of incoming) if (n === 0) queue.push(id);
  queue.sort();
  const ordered: any[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    ordered.push(byId.get(id));
    for (const tgt of succs.get(id) ?? []) {
      const n = (incoming.get(tgt) ?? 0) - 1;
      incoming.set(tgt, n);
      if (n <= 0 && !visited.has(tgt)) queue.push(tgt);
    }
    queue.sort();
  }
  // Append any nodes left out by cycles.
  for (const fe of flowNodes) if (!visited.has(fe.id)) ordered.push(fe);
  return ordered;
}
