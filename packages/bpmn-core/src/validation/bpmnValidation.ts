import type { FlowNode, FlowNodeKind, ResolvedModel } from "../dsl/ast.js";

export type BpmnValidationSeverity = "error" | "warning" | "info";
export type BpmnValidationStatus = "passed" | "warning" | "failed";
export type BpmnValidationOrigin = "model" | "layout";

export type BpmnValidationFinding = {
  code: string;
  origin: BpmnValidationOrigin;
  severity: BpmnValidationSeverity;
  elementId?: string;
  elementName?: string;
  message: string;
};

export type BpmnValidationMetrics = {
  numActivities: number;
  numGateways: number;
  numStartEvents: number;
  numEndEvents: number;
  isolatedNodes: number;
  deadEndNodes: number;
};

export type BpmnValidationResult = {
  status: BpmnValidationStatus;
  errors: BpmnValidationFinding[];
  warnings: BpmnValidationFinding[];
  info: BpmnValidationFinding[];
  metrics: BpmnValidationMetrics;
};

export type BpmnValidationOptions = {
  layoutXml?: string;
};

type DegreeMaps = {
  incoming: Map<string, string[]>;
  outgoing: Map<string, string[]>;
};

type Bounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ShapeInfo = {
  bounds: Bounds;
  elementId: string;
  elementName: string;
  tagName: string;
};

const FLOW_NODE_KINDS: ReadonlySet<FlowNodeKind> = new Set([
  "task",
  "startEvent",
  "endEvent",
  "intermediateEvent",
  "boundaryEvent",
  "exclusiveGateway",
  "parallelGateway",
  "eventBasedGateway",
]);

const GATEWAY_KINDS: ReadonlySet<FlowNodeKind> = new Set([
  "exclusiveGateway",
  "parallelGateway",
  "eventBasedGateway",
]);

const LAYOUT_ARTIFACT_TAGS = new Set([
  "bpmn:DataObjectReference",
  "bpmn:DataStoreReference",
  "bpmn:TextAnnotation",
  "bpmn:dataObjectReference",
  "bpmn:dataStoreReference",
  "bpmn:textAnnotation",
  "dataObjectReference",
  "dataStoreReference",
  "textAnnotation",
]);

const LAYOUT_CONTAINER_TAGS = new Set(["bpmn:Participant", "bpmn:participant", "bpmn:Lane", "bpmn:lane", "participant", "lane"]);
const MAX_ARTIFACT_DISTANCE = 420;

/**
 * Pure BPMN-level validation for experiment traceability.
 *
 * Limitations:
 * - ResolvedModel.pools are the DSL lane/pool labels, not explicit BPMN
 *   participant boundaries after BPMN collaboration grouping. Sequence flows
 *   across these labels are common for lanes, so participant-crossing
 *   validation is intentionally deferred until the model exposes that boundary.
 * - Label readability is a deterministic geometry heuristic. The rendered
 *   bpmn-js text layout/wrapping engine is not exposed in ResolvedModel.
 */
export function validateBpmnModel(
  model: ResolvedModel,
  options: BpmnValidationOptions = {},
): BpmnValidationResult {
  const findings: BpmnValidationFinding[] = [];
  const degree = buildDegreeMaps(model, findings);
  validateModelStructure(model, degree, findings);
  validateArtifacts(model, findings);

  if (options.layoutXml !== undefined) {
    validateLayout(options.layoutXml, findings);
  }

  const metrics = collectValidationMetrics(model, degree);
  const sorted = sortFindings(findings);
  const errors = sorted.filter((finding) => finding.severity === "error");
  const warnings = sorted.filter((finding) => finding.severity === "warning");
  const info = sorted.filter((finding) => finding.severity === "info");

  return {
    status: errors.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed",
    errors,
    warnings,
    info,
    metrics,
  };
}

function validateModelStructure(
  model: ResolvedModel,
  degree: DegreeMaps,
  findings: BpmnValidationFinding[],
): void {
  const nodes = Array.from(model.flowNodes.values()).filter(isControlNode);
  const startEvents = nodes.filter((node) => node.kind === "startEvent");
  const explicitStarts = startEvents.filter((node) => !isImplicitStart(node));
  const endEvents = nodes.filter((node) => node.kind === "endEvent");

  if (explicitStarts.length === 0) {
    findings.push({
      code: "MISSING_EXPLICIT_START_EVENT",
      origin: "model",
      severity: "warning",
      message: "The model does not contain an explicit start event from the DSL.",
    });
  }

  for (const node of startEvents.filter(isImplicitStart)) {
    findings.push({
      code: "IMPLICIT_START_EVENT",
      origin: "model",
      severity: "warning",
      elementId: node.id,
      elementName: node.label,
      message: "An implicit start event was synthesized for a node without incoming flow.",
    });
  }

  if (endEvents.length === 0) {
    findings.push({
      code: "MISSING_EXPLICIT_END_EVENT",
      origin: "model",
      severity: "warning",
      message: "The model does not contain an explicit end event.",
    });
  }

  for (const node of nodes) {
    const incoming = degree.incoming.get(node.id) ?? [];
    const outgoing = degree.outgoing.get(node.id) ?? [];

    if (incoming.length === 0 && outgoing.length === 0 && node.kind !== "boundaryEvent") {
      findings.push(finding("ISOLATED_NODE", "error", node, "The flow node is isolated."));
      continue;
    }

    if (node.kind === "task") {
      if (incoming.length === 0) {
        findings.push(finding("ACTIVITY_WITHOUT_INCOMING", "error", node, "The activity has no incoming sequence flow."));
      }
      if (outgoing.length === 0) {
        findings.push(finding("ACTIVITY_WITHOUT_OUTGOING", "error", node, "The activity has no outgoing sequence flow."));
      }
    }

    if (node.kind === "startEvent") {
      if (incoming.length > 0) {
        findings.push(finding("START_EVENT_WITH_INCOMING", "error", node, "The start event has incoming sequence flow."));
      }
      if (outgoing.length === 0) {
        findings.push(finding("START_EVENT_WITHOUT_OUTGOING", "error", node, "The start event has no outgoing sequence flow."));
      }
    }

    if (node.kind === "endEvent" && outgoing.length > 0) {
      findings.push(finding("END_EVENT_WITH_OUTGOING", "error", node, "The end event has outgoing sequence flow."));
    }

    if (GATEWAY_KINDS.has(node.kind)) {
      if (incoming.length === 0) {
        findings.push(finding("GATEWAY_WITHOUT_INCOMING", "error", node, "The gateway has no incoming sequence flow."));
      }
      if (outgoing.length === 0) {
        findings.push(finding("GATEWAY_WITHOUT_OUTGOING", "error", node, "The gateway has no outgoing sequence flow."));
      }
      if ((node.kind === "exclusiveGateway" || node.kind === "parallelGateway") && incoming.length === 1 && outgoing.length === 1) {
        findings.push(
          finding(
            "GATEWAY_SUSPICIOUS_PASSTHROUGH",
            "warning",
            node,
            "The XOR/AND gateway has one incoming and one outgoing path, so it does not split or join.",
          ),
        );
      }
    }

    if (node.kind !== "endEvent" && node.kind !== "boundaryEvent" && outgoing.length === 0) {
      findings.push(finding("DEAD_END_NODE", "error", node, "The flow node does not eventually continue to an end event."));
    }
  }

  validatePathReachability(model, degree, findings);
}

function validatePathReachability(
  model: ResolvedModel,
  degree: DegreeMaps,
  findings: BpmnValidationFinding[],
): void {
  const endIds = new Set(
    Array.from(model.flowNodes.values())
      .filter((node) => node.kind === "endEvent")
      .map((node) => node.id),
  );
  if (endIds.size === 0) return;

  const canReachEndCache = new Map<string, boolean>();
  const visiting = new Set<string>();
  const canReachEnd = (id: string): boolean => {
    const cached = canReachEndCache.get(id);
    if (cached !== undefined) return cached;
    if (endIds.has(id)) {
      canReachEndCache.set(id, true);
      return true;
    }
    if (visiting.has(id)) return false;
    visiting.add(id);
    const result = (degree.outgoing.get(id) ?? []).some(canReachEnd);
    visiting.delete(id);
    canReachEndCache.set(id, result);
    return result;
  };

  for (const node of model.flowNodes.values()) {
    if (!isControlNode(node) || node.kind === "endEvent") continue;
    const outgoing = degree.outgoing.get(node.id) ?? [];
    if (outgoing.length === 0) continue;
    if (!canReachEnd(node.id)) {
      findings.push(
        finding("BRANCH_WITHOUT_END_REACHABILITY", "error", node, "This branch does not eventually reach an end event."),
      );
    }
  }
}

function validateArtifacts(model: ResolvedModel, findings: BpmnValidationFinding[]): void {
  const dataKeys = new Map<string, FlowNode[]>();
  for (const node of model.flowNodes.values()) {
    if (node.kind !== "dataObject" && node.kind !== "dataStore") continue;
    const key = `${node.kind}::${node.pool}::${node.label.trim().toLowerCase()}`;
    const group = dataKeys.get(key) ?? [];
    group.push(node);
    dataKeys.set(key, group);
  }
  for (const group of dataKeys.values()) {
    if (group.length <= 1) continue;
    const first = group[0];
    findings.push(
      finding("DUPLICATED_DATA_OBJECT", "warning", first, "Duplicate data object/store labels exist in the same pool."),
    );
  }

  for (const node of model.flowNodes.values()) {
    const seen = new Set<string>();
    for (const annotation of node.annotations) {
      const key = annotation.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        findings.push(
          finding("DUPLICATED_COMMENT", "warning", node, "The same comment is attached more than once to this element."),
        );
        break;
      }
      seen.add(key);
    }
  }
}

function validateLayout(layoutXml: string, findings: BpmnValidationFinding[]): void {
  const doc = new DOMParser().parseFromString(layoutXml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    findings.push({
      code: "LAYOUT_XML_PARSE_ERROR",
      origin: "layout",
      severity: "warning",
      message: "The rendered BPMN XML could not be parsed for layout validation.",
    });
    return;
  }

  const shapes = readShapes(doc);
  const blockingShapes = shapes.filter(
    (shape) => !LAYOUT_CONTAINER_TAGS.has(shape.tagName) && !LAYOUT_ARTIFACT_TAGS.has(shape.tagName),
  );

  for (let i = 0; i < blockingShapes.length; i += 1) {
    for (let j = i + 1; j < blockingShapes.length; j += 1) {
      const a = blockingShapes[i];
      const b = blockingShapes[j];
      if (!boxesOverlap(a.bounds, b.bounds, 4)) continue;
      findings.push({
        code: "LAYOUT_ELEMENT_OVERLAP",
        origin: "layout",
        severity: "warning",
        elementId: a.elementId,
        elementName: a.elementName,
        message: `The rendered element overlaps '${b.elementName || b.elementId}'.`,
      });
    }
  }

  for (const shape of shapes) {
    if (shape.elementName.length === 0) continue;
    if (LAYOUT_CONTAINER_TAGS.has(shape.tagName)) continue;
    if (LAYOUT_ARTIFACT_TAGS.has(shape.tagName)) continue;
    if (shape.elementName.length * 7 <= shape.bounds.width + 20) continue;
    findings.push({
      code: "LAYOUT_UNREADABLE_LABEL",
      origin: "layout",
      severity: "warning",
      elementId: shape.elementId,
      elementName: shape.elementName,
      message: "The rendered label may be too long to remain readable inside its element.",
    });
  }

  validateArtifactDistances(doc, shapes, findings);
}

function validateArtifactDistances(
  doc: Document,
  shapes: ShapeInfo[],
  findings: BpmnValidationFinding[],
): void {
  const shapeById = new Map(shapes.map((shape) => [shape.elementId, shape]));
  const associations = Array.from(doc.getElementsByTagName("bpmn:association")).concat(
    Array.from(doc.getElementsByTagName("association")),
  );

  for (const association of associations) {
    const sourceRef = association.getAttribute("sourceRef");
    const targetRef = association.getAttribute("targetRef");
    if (sourceRef === null || targetRef === null) continue;
    const source = shapeById.get(sourceRef);
    const target = shapeById.get(targetRef);
    if (source === undefined || target === undefined) continue;
    const artifact = LAYOUT_ARTIFACT_TAGS.has(source.tagName)
      ? source
      : LAYOUT_ARTIFACT_TAGS.has(target.tagName)
        ? target
        : undefined;
    if (artifact === undefined) continue;
    const distance = centerDistance(source.bounds, target.bounds);
    if (distance <= MAX_ARTIFACT_DISTANCE) continue;
    findings.push({
      code: "LAYOUT_ARTIFACT_TOO_FAR",
      origin: "layout",
      severity: "warning",
      elementId: artifact.elementId,
      elementName: artifact.elementName,
      message: "The data object or comment is placed far from its associated activity.",
    });
  }
}

function buildDegreeMaps(model: ResolvedModel, findings: BpmnValidationFinding[]): DegreeMaps {
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const flow of model.flows) {
    const source = model.flowNodes.get(flow.sourceId);
    const target = model.flowNodes.get(flow.targetId);
    if (source === undefined || target === undefined) {
      findings.push({
        code: "SEQUENCE_FLOW_INVALID_REFERENCE",
        origin: "model",
        severity: "error",
        elementId: flow.id,
        message: "The sequence flow references a missing source or target element.",
      });
      continue;
    }
    pushMap(outgoing, source.id, target.id);
    pushMap(incoming, target.id, source.id);
  }

  for (const messageFlow of model.messageFlows) {
    const source = model.flowNodes.get(messageFlow.sourceId);
    const target = model.flowNodes.get(messageFlow.targetId);
    if (source === undefined || target === undefined) {
      findings.push({
        code: "MESSAGE_FLOW_INVALID_REFERENCE",
        origin: "model",
        severity: "error",
        elementId: messageFlow.id,
        elementName: messageFlow.label,
        message: "The message flow references a missing source or target element.",
      });
      continue;
    }
    if (source.pool === target.pool) {
      findings.push({
        code: "MESSAGE_FLOW_WITHIN_POOL",
        origin: "model",
        severity: "error",
        elementId: messageFlow.id,
        elementName: messageFlow.label,
        message: "The message flow connects elements in the same pool.",
      });
    }
    if (source.eventType !== "send" || (target.eventType !== "receive" && target.eventType !== "received")) {
      findings.push({
        code: "MESSAGE_FLOW_INVALID_ENDPOINT",
        origin: "model",
        severity: "error",
        elementId: messageFlow.id,
        elementName: messageFlow.label,
        message: "The message flow should connect a send event to a receive event.",
      });
    }
  }

  return { incoming, outgoing };
}

function collectValidationMetrics(model: ResolvedModel, degree: DegreeMaps): BpmnValidationMetrics {
  const nodes = Array.from(model.flowNodes.values()).filter(isControlNode);
  return {
    numActivities: nodes.filter((node) => node.kind === "task").length,
    numGateways: nodes.filter((node) => GATEWAY_KINDS.has(node.kind)).length,
    numStartEvents: nodes.filter((node) => node.kind === "startEvent").length,
    numEndEvents: nodes.filter((node) => node.kind === "endEvent").length,
    isolatedNodes: nodes.filter((node) => {
      if (node.kind === "boundaryEvent") return false;
      return (degree.incoming.get(node.id) ?? []).length === 0 && (degree.outgoing.get(node.id) ?? []).length === 0;
    }).length,
    deadEndNodes: nodes.filter((node) => {
      if (node.kind === "endEvent" || node.kind === "boundaryEvent") return false;
      return (degree.outgoing.get(node.id) ?? []).length === 0;
    }).length,
  };
}

function readShapes(doc: Document): ShapeInfo[] {
  const shapeElements = Array.from(doc.getElementsByTagName("bpmndi:BPMNShape")).concat(
    Array.from(doc.getElementsByTagName("BPMNShape")),
  );
  const shapes: ShapeInfo[] = [];
  for (const shapeElement of shapeElements) {
    const elementId = shapeElement.getAttribute("bpmnElement");
    if (elementId === null) continue;
    const boundsElement = firstElementByTag(shapeElement, "dc:Bounds") ?? firstElementByTag(shapeElement, "Bounds");
    if (boundsElement === undefined) continue;
    const bounds = readBounds(boundsElement);
    if (bounds === undefined) continue;
    const bpmnElement = findById(doc, elementId);
    shapes.push({
      bounds,
      elementId,
      elementName: bpmnElement?.getAttribute("name") ?? "",
      tagName: bpmnElement?.tagName ?? "",
    });
  }
  return shapes.sort((a, b) => a.elementId.localeCompare(b.elementId));
}

function firstElementByTag(parent: Element, tagName: string): Element | undefined {
  return Array.from(parent.getElementsByTagName(tagName))[0];
}

function findById(doc: Document, id: string): Element | undefined {
  return Array.from(doc.getElementsByTagName("*")).find((el) => el.getAttribute("id") === id);
}

function readBounds(el: Element): Bounds | undefined {
  const x = Number(el.getAttribute("x"));
  const y = Number(el.getAttribute("y"));
  const width = Number(el.getAttribute("width"));
  const height = Number(el.getAttribute("height"));
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function boxesOverlap(a: Bounds, b: Bounds, pad: number): boolean {
  return !(
    a.x + a.width <= b.x + pad ||
    b.x + b.width <= a.x + pad ||
    a.y + a.height <= b.y + pad ||
    b.y + b.height <= a.y + pad
  );
}

function centerDistance(a: Bounds, b: Bounds): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function isControlNode(node: FlowNode): boolean {
  return FLOW_NODE_KINDS.has(node.kind);
}

function isImplicitStart(node: FlowNode): boolean {
  return node.kind === "startEvent" && node.id.startsWith("StartEvent_implicit");
}

function finding(
  code: string,
  severity: BpmnValidationSeverity,
  node: FlowNode,
  message: string,
): BpmnValidationFinding {
  return {
    code,
    origin: "model",
    severity,
    elementId: node.id,
    elementName: node.label,
    message,
  };
}

function pushMap(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function sortFindings(findings: BpmnValidationFinding[]): BpmnValidationFinding[] {
  return [...findings].sort((a, b) => {
    const severity = severityOrder(a.severity) - severityOrder(b.severity);
    if (severity !== 0) return severity;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return (a.elementId ?? "").localeCompare(b.elementId ?? "");
  });
}

function severityOrder(severity: BpmnValidationSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}
