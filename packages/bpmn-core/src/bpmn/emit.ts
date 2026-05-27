import type { EventSubtype, FlowNode, ResolvedModel, TaskType } from "../dsl/ast.js";
import { slug } from "../dsl/semantic.js";
import { el, escape, selfEl, text } from "./xml.js";

/**
 * Spec §6.3 — task-type keywords promote a generic task to a typed BPMN task.
 * The mapping below is the complete set Sketch Miner supports today; adding a
 * new keyword means (1) extending TaskType in ast.ts, (2) adding it to
 * TASK_TYPE_KEYWORDS in lexer.ts, and (3) registering its BPMN tag here.
 */
const TASK_TAG_BY_TYPE: Record<TaskType, string> = {
  user: "bpmn:userTask",
  service: "bpmn:serviceTask",
  rule: "bpmn:businessRuleTask",
  manual: "bpmn:manualTask",
  receive: "bpmn:receiveTask",
  send: "bpmn:sendTask",
  script: "bpmn:scriptTask",
};

const NS = {
  bpmn: "http://www.omg.org/spec/BPMN/20100524/MODEL",
  bpmndi: "http://www.omg.org/spec/BPMN/20100524/DI",
  dc: "http://www.omg.org/spec/DD/20100524/DC",
  di: "http://www.omg.org/spec/DD/20100524/DI",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
};

const THROW_INTERMEDIATE: ReadonlySet<EventSubtype> = new Set<EventSubtype>([
  "send",
  "escalate",
  "escalated",
  "publish",
  "notify",
  "link",
]);

type Participant = {
  id: string;
  name: string;
  processId: string;
  poolNames: string[];
};

export function emitBpmnXml(model: ResolvedModel): string {
  const fixed = fixUpEmptyPools(model);
  const participants = groupPools(fixed);

  const collaborationBody: string[] = [];
  for (const p of participants) {
    collaborationBody.push(
      selfEl("bpmn:participant", {
        id: p.id,
        name: p.name,
        processRef: p.processId,
      }),
    );
  }
  for (const mf of fixed.messageFlows) {
    collaborationBody.push(
      selfEl("bpmn:messageFlow", {
        id: mf.id,
        name: mf.label || undefined,
        sourceRef: mf.sourceId,
        targetRef: mf.targetId,
      }),
    );
  }

  const processes: string[] = [];
  for (const p of participants) {
    processes.push(emitProcess(p, fixed));
  }

  const body = [
    el("bpmn:collaboration", { id: "Collaboration_1" }, collaborationBody.join("")),
    ...processes,
  ].join("");

  const root = el(
    "bpmn:definitions",
    {
      "xmlns:bpmn": NS.bpmn,
      "xmlns:bpmndi": NS.bpmndi,
      "xmlns:dc": NS.dc,
      "xmlns:di": NS.di,
      "xmlns:xsi": NS.xsi,
      id: "Definitions_1",
      targetNamespace: "http://bpmn.io/schema/bpmn",
    },
    body,
  );

  return `<?xml version="1.0" encoding="UTF-8"?>\n${root}\n`;
}

/** Assign every FlowNode a non-empty pool, walking sequence flows until no node is empty. */
function fixUpEmptyPools(model: ResolvedModel): ResolvedModel {
  const nodes = new Map<string, FlowNode>();
  for (const [id, n] of model.flowNodes) nodes.set(id, { ...n });

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const f of model.flows) {
    (outgoing.get(f.sourceId) ?? outgoing.set(f.sourceId, []).get(f.sourceId)!).push(f.targetId);
    (incoming.get(f.targetId) ?? incoming.set(f.targetId, []).get(f.targetId)!).push(f.sourceId);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      if (n.pool) continue;
      const preds = incoming.get(n.id) ?? [];
      for (const pid of preds) {
        const p = nodes.get(pid);
        if (p?.pool) {
          n.pool = p.pool;
          changed = true;
          break;
        }
      }
      if (n.pool) continue;
      const succs = outgoing.get(n.id) ?? [];
      for (const sid of succs) {
        const s = nodes.get(sid);
        if (s?.pool) {
          n.pool = s.pool;
          changed = true;
          break;
        }
      }
    }
  }

  // Boundary events: align with their attached task.
  for (const n of nodes.values()) {
    if (n.kind === "boundaryEvent" && n.attachedTo) {
      const attached = nodes.get(n.attachedTo);
      if (attached?.pool) n.pool = attached.pool;
    }
  }

  // Last-resort fallback to first declared pool.
  const fallback = model.pools[0]?.name ?? "";
  for (const n of nodes.values()) {
    if (!n.pool) n.pool = fallback;
  }

  // Rebuild pool index with the fixed-up pools.
  const pools = model.pools.map((p) => ({ name: p.name, nodeIds: [] as string[] }));
  for (const n of nodes.values()) {
    const target = pools.find((p) => p.name === n.pool);
    if (target) target.nodeIds.push(n.id);
    else if (pools.length > 0) pools[0].nodeIds.push(n.id);
  }

  return { ...model, flowNodes: nodes, pools };
}

/** Union-find on pool names: connect any two pools that share a sequence flow. */
function groupPools(model: ResolvedModel): Participant[] {
  const poolNames = model.pools.map((p) => p.name);
  if (poolNames.length === 0) {
    return [
      {
        id: "Participant_1",
        name: "Process",
        processId: "Process_1",
        poolNames: [],
      },
    ];
  }

  const parent = new Map<string, string>();
  for (const name of poolNames) parent.set(name, name);
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let cur = x;
    while (parent.get(cur) !== r) {
      const next = parent.get(cur)!;
      parent.set(cur, r);
      cur = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const f of model.flows) {
    const sp = model.flowNodes.get(f.sourceId)?.pool;
    const tp = model.flowNodes.get(f.targetId)?.pool;
    if (sp && tp && sp !== tp && parent.has(sp) && parent.has(tp)) union(sp, tp);
  }

  // Group pools by root, preserving DSL declaration order.
  const groups = new Map<string, string[]>();
  for (const name of poolNames) {
    const r = find(name);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(name);
  }

  // Walk poolNames again to keep deterministic participant order.
  const seen = new Set<string>();
  const participants: Participant[] = [];
  let counter = 0;
  for (const name of poolNames) {
    const r = find(name);
    if (seen.has(r)) continue;
    seen.add(r);
    const members = groups.get(r)!;
    counter++;
    const idSlug = slug(members[0]) || `p${counter}`;
    participants.push({
      id: `Participant_${idSlug}`,
      name: members[0],
      processId: `Process_${idSlug}`,
      poolNames: members,
    });
  }
  return participants;
}

function emitProcess(p: Participant, model: ResolvedModel): string {
  const memberPools = new Set(p.poolNames);
  const nodesInProcess: FlowNode[] = [];
  for (const n of model.flowNodes.values()) {
    if (memberPools.has(n.pool)) nodesInProcess.push(n);
  }

  // Lane set: one lane per pool, with flowNodeRef children for true flow nodes only
  // (BPMN 2.0: data refs are flowElements, not flowNodes — excluded).
  const laneRefsByPool = new Map<string, string[]>();
  for (const name of p.poolNames) laneRefsByPool.set(name, []);
  for (const n of nodesInProcess) {
    if (n.kind === "dataObject" || n.kind === "dataStore") continue;
    const refs = laneRefsByPool.get(n.pool);
    if (refs) refs.push(n.id);
  }
  const lanes: string[] = [];
  for (const poolName of p.poolNames) {
    const refs = laneRefsByPool.get(poolName) ?? [];
    const refEls = refs.map((id) => el("bpmn:flowNodeRef", undefined, escape(id)));
    lanes.push(
      el(
        "bpmn:lane",
        { id: `Lane_${slug(poolName)}`, name: poolName },
        refEls.join(""),
      ),
    );
  }
  const laneSet = el(
    "bpmn:laneSet",
    { id: `LaneSet_${slug(p.name)}` },
    lanes.join(""),
  );

  // Precompute incoming/outgoing flow IDs per node — BPMN requires these as child
  // elements on every flow node for auto-layout to traverse the graph.
  const incomingByNode = new Map<string, string[]>();
  const outgoingByNode = new Map<string, string[]>();
  for (const f of model.flows) {
    (outgoingByNode.get(f.sourceId) ?? outgoingByNode.set(f.sourceId, []).get(f.sourceId)!).push(f.id);
    (incomingByNode.get(f.targetId) ?? incomingByNode.set(f.targetId, []).get(f.targetId)!).push(f.id);
  }

  // Element bodies.
  const nodeXmls = nodesInProcess.map((n) =>
    emitFlowNode(n, incomingByNode.get(n.id) ?? [], outgoingByNode.get(n.id) ?? []),
  );

  // Sequence flows whose source is in this process.
  const flowsInProcess = model.flows.filter((f) => {
    const src = model.flowNodes.get(f.sourceId);
    return src ? memberPools.has(src.pool) : false;
  });
  const flowXmls = flowsInProcess.map((f) =>
    selfEl("bpmn:sequenceFlow", {
      id: f.id,
      name: f.conditionLabel || undefined,
      sourceRef: f.sourceId,
      targetRef: f.targetId,
    }),
  );

  // Text annotations + associations: one per (node, annotation string).
  // Plus: one association per data ref → its attached task.
  const annotationXmls: string[] = [];
  const associationXmls: string[] = [];
  let annoCounter = 0;
  let assocCounter = 0;
  for (const n of nodesInProcess) {
    for (const a of n.annotations) {
      annoCounter++;
      const annoId = `TextAnnotation_${slug(p.name) || "p"}_${annoCounter}`;
      annotationXmls.push(
        el(
          "bpmn:textAnnotation",
          { id: annoId },
          el("bpmn:text", undefined, text(a)),
        ),
      );
      assocCounter++;
      const assocId = `Association_${slug(p.name) || "p"}_${assocCounter}`;
      associationXmls.push(
        selfEl("bpmn:association", {
          id: assocId,
          sourceRef: n.id,
          targetRef: annoId,
        }),
      );
    }
  }
  for (const n of nodesInProcess) {
    if (n.kind !== "dataObject" && n.kind !== "dataStore") continue;
    // Output association: producing task → data node.
    if (n.attachedTo) {
      assocCounter++;
      associationXmls.push(
        selfEl("bpmn:association", {
          id: `Association_${slug(p.name) || "p"}_${assocCounter}`,
          sourceRef: n.attachedTo,
          targetRef: n.id,
        }),
      );
    }
    // Input association: data node → consuming task. Spec §11.1 — a data
    // object between two tasks is canonically both an output of the upstream
    // task AND an input to the downstream one.
    if (n.attachedInputOf && n.attachedInputOf !== n.attachedTo) {
      assocCounter++;
      associationXmls.push(
        selfEl("bpmn:association", {
          id: `Association_${slug(p.name) || "p"}_${assocCounter}`,
          sourceRef: n.id,
          targetRef: n.attachedInputOf,
        }),
      );
    }
  }

  const body = [
    laneSet,
    ...nodeXmls,
    ...flowXmls,
    ...annotationXmls,
    ...associationXmls,
  ].join("");

  return el(
    "bpmn:process",
    { id: p.processId, isExecutable: "false" },
    body,
  );
}

function flowRefs(incoming: string[], outgoing: string[]): string {
  const parts: string[] = [];
  for (const id of incoming) parts.push(el("bpmn:incoming", undefined, escape(id)));
  for (const id of outgoing) parts.push(el("bpmn:outgoing", undefined, escape(id)));
  return parts.join("");
}

function emitFlowNode(n: FlowNode, incoming: string[], outgoing: string[]): string {
  const refs = flowRefs(incoming, outgoing);
  switch (n.kind) {
    case "task": {
      const tag = n.taskType ? TASK_TAG_BY_TYPE[n.taskType] : "bpmn:task";
      return el(tag, { id: n.id, name: n.label || undefined }, refs);
    }
    case "startEvent":
      return emitEvent("bpmn:startEvent", n, refs);
    case "endEvent":
      return emitEvent("bpmn:endEvent", n, refs);
    case "intermediateEvent": {
      const isThrow = n.eventType ? THROW_INTERMEDIATE.has(n.eventType) : false;
      return emitEvent(isThrow ? "bpmn:intermediateThrowEvent" : "bpmn:intermediateCatchEvent", n, refs);
    }
    case "boundaryEvent":
      return emitEvent("bpmn:boundaryEvent", n, refs);
    case "exclusiveGateway":
      return el("bpmn:exclusiveGateway", { id: n.id, name: n.label || undefined }, refs);
    case "parallelGateway":
      return el("bpmn:parallelGateway", { id: n.id, name: n.label || undefined }, refs);
    case "eventBasedGateway":
      return el("bpmn:eventBasedGateway", { id: n.id, name: n.label || undefined }, refs);
    case "dataObject":
      return el("bpmn:dataObjectReference", { id: n.id, name: n.label || undefined });
    case "dataStore":
      return el("bpmn:dataStoreReference", { id: n.id, name: n.label || undefined });
  }
}

function emitEvent(tag: string, n: FlowNode, refs: string): string {
  const attrs: Record<string, string | undefined> = {
    id: n.id,
    name: n.label || undefined,
  };
  if (tag === "bpmn:boundaryEvent") {
    if (n.attachedTo) attrs.attachedToRef = n.attachedTo;
    attrs.cancelActivity = n.interrupting === false ? "false" : "true";
  }
  const def = eventDefinitionFor(n.eventType);
  return el(tag, attrs, refs + def);
}

function eventDefinitionFor(et: EventSubtype | undefined): string {
  if (!et) return "";
  switch (et) {
    case "timer":
    case "deadline":
      return selfEl("bpmn:timerEventDefinition");
    case "message":
    case "received":
    case "receive":
    case "send":
      return selfEl("bpmn:messageEventDefinition");
    case "signal":
      return selfEl("bpmn:signalEventDefinition");
    case "error":
    case "exception":
      return selfEl("bpmn:errorEventDefinition");
    case "escalate":
    case "escalated":
      return selfEl("bpmn:escalationEventDefinition");
    case "terminate":
      return selfEl("bpmn:terminateEventDefinition");
    case "link":
      return selfEl("bpmn:linkEventDefinition");
    default:
      return "";
  }
}

