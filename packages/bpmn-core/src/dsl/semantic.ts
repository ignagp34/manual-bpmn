import type {
  DataStep,
  DslError,
  EventStep,
  EventSubtype,
  FlowNode,
  FlowNodeKind,
  MessageFlow,
  ParallelStep,
  Program,
  ResolvedModel,
  ResolvedPool,
  SequenceFlow,
  Step,
  TaskStep,
  TaskType,
  Trace,
} from "./ast.js";

/**
 * Spec §9.9 — boundary events use *only* the four keywords below (plus the
 * `escalate` alias of `escalated`). Other event keywords (`timer`, `error`,
 * `message`, `signal`) deliberately stay OUT of this set: when they appear on
 * a line after a task they are intermediate events on the sequence flow, not
 * boundary events on the task. The Sketch Miner reference renderer agrees —
 * canonical example 4 has `(timer 3 to 8 weeks)` between `Sanitize compost`
 * and `Cool down`, and the resulting diagram puts a clock on the SEQUENCE
 * arrow, not on the task perimeter.
 *
 * Scope note for future changes: this set defines what `attachBoundaryEvents`
 * pulls off the trace. If Sketch Miner ever extends boundary support to a new
 * keyword (or you add a custom one), add it HERE — and at the same time
 * confirm `eventDefinitionFor` in src/bpmn/emit.ts emits the right BPMN
 * `<*EventDefinition/>` for it. Do NOT add `timer`, `error`, `message`, or
 * `signal` back to this set without also revisiting `(timer X)`-as-delay
 * semantics; you'll quietly regress canonical example 4.
 */
const BOUNDARY_SUBTYPES: ReadonlySet<EventSubtype> = new Set<EventSubtype>([
  "deadline",
  "exception",
  "received",
  "escalated",
  "escalate",
]);

const START_CAPABLE: ReadonlySet<EventSubtype> = new Set<EventSubtype>([
  "start",
  "timer",
  "message",
  "signal",
  "receive",
  "received",
]);

const END_CAPABLE: ReadonlySet<EventSubtype> = new Set<EventSubtype>([
  "finish",
  "end",
  "terminate",
  "error",
  "escalate",
  "escalated",
]);

export function slug(s: string): string {
  return s
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 60);
}

function isFlowStep(s: Step): s is TaskStep | EventStep {
  return s.kind === "Task" || s.kind === "Event";
}

/** Pass A: enforce first-mention pool persistence across the program. */
function applyPoolFirstMention(program: Program): void {
  const labelToPool = new Map<string, string>();
  for (const trace of program.traces) {
    for (const step of trace.steps) {
      if (step.kind !== "Task") continue;
      const seen = labelToPool.get(step.label);
      if (seen === undefined) {
        labelToPool.set(step.label, step.pool);
      } else if (seen !== step.pool) {
        step.pool = seen;
        step.mergeKey = `${seen}::${step.label}`;
      }
    }
    for (const step of trace.steps) {
      if (step.kind !== "Parallel") continue;
      for (const lane of step.lanes) {
        const seen = labelToPool.get(lane.label);
        if (seen === undefined) {
          labelToPool.set(lane.label, lane.pool);
        } else if (seen !== lane.pool) {
          lane.pool = seen;
          lane.mergeKey = `${seen}::${lane.label}`;
        }
      }
    }
  }
  // Re-resolve fragment anchors after possible pool-key changes.
  for (const trace of program.traces) {
    if (!trace.isFragment) continue;
    const real = trace.steps.filter((s) => s.kind === "Task" || s.kind === "Event" || s.kind === "FragmentMarker");
    if (real.length === 0) continue;
    if (real[0].kind === "FragmentMarker") {
      const after = real.find((s) => s.kind === "Task" || s.kind === "Event") as TaskStep | EventStep | undefined;
      if (after) trace.leadingAnchor = after.mergeKey;
    }
    if (real[real.length - 1].kind === "FragmentMarker") {
      const before = [...real].reverse().find((s) => s.kind === "Task" || s.kind === "Event") as
        | TaskStep
        | EventStep
        | undefined;
      if (before) trace.trailingAnchor = before.mergeKey;
    }
  }
}

/** Pre-Pass: pull annotation steps into the next flow step's annotations array.
 *
 * A `//` line directly before a Parallel split (e.g. `IT Security: ... | Finance: ...`)
 * attaches to the parallel gateway — recorded in `parallelAnnotationsByKey` for
 * later unioning into the parallelGateway flow node. This stops the annotation
 * from skipping past the split and landing on the activity after the parallel. */
function attachAnnotations(
  program: Program,
  parallelAnnotationsByKey: Map<string, string[]>,
): void {
  for (const trace of program.traces) {
    const out: Step[] = [];
    let pending: string[] = [];
    for (const step of trace.steps) {
      if (step.kind === "Annotation") {
        pending.push(step.text);
        continue;
      }
      if (pending.length > 0 && (step.kind === "Task" || step.kind === "Event")) {
        step.annotations.push(...pending);
        pending = [];
      } else if (pending.length > 0 && step.kind === "Parallel") {
        const key = parallelSplitKey(step);
        const arr = parallelAnnotationsByKey.get(key) ?? [];
        for (const ann of pending) if (!arr.includes(ann)) arr.push(ann);
        parallelAnnotationsByKey.set(key, arr);
        pending = [];
      }
      out.push(step);
    }
    trace.steps = out;
  }
}

/** Pre-Pass: attach boundary events ((deadline …) immediately after a task) to that task. */
function attachBoundaryEvents(program: Program): void {
  for (const trace of program.traces) {
    const out: Step[] = [];
    // After plucking a boundary, the next flow step in this trace is reachable
    // via the boundary firing — mark it so the edge-builder routes its
    // incoming flow from the boundary instead of from the host task.
    let pendingHost: TaskStep | undefined;
    let pendingBoundary: EventStep | undefined;
    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      if (
        step.kind === "Event" &&
        BOUNDARY_SUBTYPES.has(step.eventType) &&
        out.length > 0 &&
        out[out.length - 1].kind === "Task"
      ) {
        const prev = out[out.length - 1] as TaskStep;
        const eventStep: EventStep = { ...step, isDoubleParen: step.isDoubleParen };
        prev.boundary.push(eventStep);
        pendingHost = prev;
        pendingBoundary = eventStep;
        continue;
      }
      if (pendingHost && pendingBoundary && (step.kind === "Task" || step.kind === "Event")) {
        const map = (trace.boundaryEdgeOverride ??= new Map());
        map.set(step, `__boundary__::${pendingHost.mergeKey}::${pendingBoundary.rawInner}`);
      }
      if (step.kind === "Task" || step.kind === "Event" || step.kind === "Parallel") {
        // Once we hit any other flow-bearing step the boundary's reach ends.
        pendingHost = undefined;
        pendingBoundary = undefined;
      }
      out.push(step);
    }
    trace.steps = out;
  }
}

type AnchorIndexEntry = {
  asLeading: Trace[];
  asTrailing: Trace[];
};

function buildAnchorIndex(traces: Trace[]): Map<string, AnchorIndexEntry> {
  const idx = new Map<string, AnchorIndexEntry>();
  const get = (k: string) => {
    let e = idx.get(k);
    if (!e) {
      e = { asLeading: [], asTrailing: [] };
      idx.set(k, e);
    }
    return e;
  };
  for (const t of traces) {
    if (t.leadingAnchor) get(t.leadingAnchor).asLeading.push(t);
    if (t.trailingAnchor) get(t.trailingAnchor).asTrailing.push(t);
  }
  return idx;
}

function collectMergeKeys(traces: Trace[]): Set<string> {
  const out = new Set<string>();
  for (const t of traces) {
    for (const s of t.steps) {
      if (s.kind === "Task" || s.kind === "Event") out.add(s.mergeKey);
      if (s.kind === "Parallel") for (const lane of s.lanes) out.add(lane.mergeKey);
    }
  }
  return out;
}

/** Pass C: AP-6 / AP-7 detection. */
function detectAnchorViolations(program: Program): void {
  const anchorIndex = buildAnchorIndex(program.traces);

  // AP-6: regular trace whose last flow step is a leading-anchor of some fragment.
  for (const trace of program.traces) {
    if (trace.isFragment) continue;
    const lastFlow = [...trace.steps].reverse().find(isFlowStep);
    if (!lastFlow) continue;
    const entry = anchorIndex.get(lastFlow.mergeKey);
    if (entry && entry.asLeading.length > 0) {
      program.errors.push({
        line: lastFlow.line,
        code: "AP-6",
        severity: "error",
        message: `Regular trace ends at fragment anchor '${lastFlow.label}'. Add a trailing '...' so the anchor stays at the fragment boundary.`,
      });
    }
  }

  // AP-7: anchor task appears in a fragment trace at a non-boundary position.
  for (const [key, entry] of anchorIndex.entries()) {
    if (entry.asLeading.length === 0 && entry.asTrailing.length === 0) continue;
    for (const trace of program.traces) {
      if (!trace.isFragment) continue;
      const flowSteps = trace.steps.filter(isFlowStep);
      if (flowSteps.length === 0) continue;
      const matches = flowSteps.map((s, i) => ({ step: s, i })).filter((p) => p.step.mergeKey === key);
      if (matches.length === 0) continue;
      const lastIdx = flowSteps.length - 1;
      for (const { step, i } of matches) {
        // Clean position: anchor at the very start or end of the trace's flow steps,
        // regardless of which boundary the trace itself declares (§12.1).
        const isBoundary = i === 0 || i === lastIdx;
        if (!isBoundary) {
          program.errors.push({
            line: step.line,
            code: "AP-7",
            severity: "error",
            message: `Anchor '${step.label}' is buried inside a fragment; move it to the '...' boundary.`,
          });
        }
      }
    }
  }

  // ANCHOR-MISSING: anchor referenced by a fragment but never appears as a real step elsewhere.
  const allKeys = collectMergeKeys(program.traces);
  for (const [key, entry] of anchorIndex.entries()) {
    const references = entry.asLeading.length + entry.asTrailing.length;
    if (references === 0) continue;
    if (!allKeys.has(key)) {
      const sample = entry.asLeading[0] ?? entry.asTrailing[0];
      const sampleLine = sample.steps.find(isFlowStep)?.line ?? sample.startLine;
      program.errors.push({
        line: sampleLine,
        code: "ANCHOR-MISSING",
        severity: "error",
        message: `Fragment anchor '${key.split("::")[1] ?? key}' has no matching task in any non-fragment trace.`,
      });
    }
  }
}

type IdAllocator = {
  for: (prefix: string, key: string) => string;
};

function makeIdAllocator(): IdAllocator {
  const counters = new Map<string, number>();
  const interned = new Map<string, string>();
  return {
    for(prefix: string, key: string): string {
      const cacheKey = `${prefix}::${key}`;
      const existing = interned.get(cacheKey);
      if (existing) return existing;
      const slugged = slug(key) || "x";
      const next = (counters.get(prefix + slugged) ?? 0) + 1;
      counters.set(prefix + slugged, next);
      const id = next === 1 ? `${prefix}_${slugged}` : `${prefix}_${slugged}_${next}`;
      interned.set(cacheKey, id);
      return id;
    },
  };
}

type EdgePath = {
  pool: string;
  steps: Array<{ key: string; line: number; skipIncoming?: boolean }>;
  edgeLabels: Map<number, string>; // index of "from" step → condition label for outgoing edge
};

/**
 * Synthetic key for a parallel row.
 *
 * The key is content-based (sorted lane mergeKeys), NOT line-based. Two
 * parallel rows that share lane composition therefore converge on the same
 * synthetic gateway — a direct application of spec rule 3 ("Each Element
 * Once") to parallel constructs and the §12.7 unequal-parallel idiom.
 *
 * If the lanes are reordered (`A|B` vs `B|A`) the sort makes them collide;
 * Sketch Miner treats parallel as set-valued and so do we.
 */
function parallelSplitKey(step: ParallelStep): string {
  const laneKeys = step.lanes.map((l) => l.mergeKey).sort();
  return `__parallel__::${laneKeys.join("|")}`;
}

function parallelJoinKey(step: ParallelStep): string {
  const laneKeys = step.lanes.map((l) => l.mergeKey).sort();
  return `__parallel_join__::${laneKeys.join("|")}`;
}

/** Walks a trace and produces a path of mergeKeys, applying ?-condition rule and skipping non-flow steps. */
function tracePath(trace: Trace): EdgePath {
  const path: Array<{ key: string; line: number; skipIncoming?: boolean }> = [];
  const labels = new Map<number, string>();
  let pendingQuestion = false;
  let pendingCondition: string | undefined;
  let pool = "";

  const flush = (key: string, line: number, skipIncoming?: boolean) => {
    if (pendingCondition !== undefined && path.length > 0) {
      labels.set(path.length - 1, pendingCondition);
    }
    path.push({ key, line, skipIncoming });
    pendingCondition = undefined;
  };

  // Splice the boundary's flow-source key into the path right before its
  // controlled step. The boundary key entry carries skipIncoming so the
  // host-task → boundary edge is suppressed; the boundary → controlled-step
  // edge is emitted normally on the next iteration.
  const insertBoundaryBefore = (step: TaskStep | EventStep) => {
    const boundaryKey = trace.boundaryEdgeOverride?.get(step);
    if (boundaryKey !== undefined) {
      path.push({ key: boundaryKey, line: step.line, skipIncoming: true });
    }
  };

  for (const step of trace.steps) {
    if (step.kind === "Question") {
      pendingQuestion = true;
      continue;
    }
    if (step.kind === "Task") {
      pool = pool || step.pool;
      if (pendingQuestion) {
        pendingCondition = step.label;
        pendingQuestion = false;
        continue;
      }
      insertBoundaryBefore(step);
      flush(step.mergeKey, step.line);
    } else if (step.kind === "Event") {
      pool = pool || step.pool;
      if (pendingQuestion) {
        // event-typed condition is unusual; treat as condition label.
        pendingCondition = step.label;
        pendingQuestion = false;
        continue;
      }
      insertBoundaryBefore(step);
      flush(step.mergeKey, step.line);
    } else if (step.kind === "Parallel") {
      // Treat the parallel block as a single synthetic node in the path; XOR/parallel synthesis happens in build.
      flush(parallelSplitKey(step), step.line);
    }
    // FragmentMarker, PoolScope, Annotation, Data are ignored for path-building.
  }
  return { pool, steps: path, edgeLabels: labels };
}

function classifyEventKind(
  ev: EventStep,
  positionAtStart: boolean,
  positionAtEnd: boolean,
): FlowNodeKind {
  // Subtype-driven classification first: `start` is always a start event,
  // `finish | end | terminate` are always end events.
  if (ev.eventType === "start") return "startEvent";
  if (ev.eventType === "finish" || ev.eventType === "end" || ev.eventType === "terminate") {
    return "endEvent";
  }
  // Untyped or position-sensitive subtypes (timer, message, signal, receive, …):
  if (positionAtStart && START_CAPABLE.has(ev.eventType)) return "startEvent";
  if (positionAtEnd && END_CAPABLE.has(ev.eventType)) return "endEvent";
  return "intermediateEvent";
}

/** Identify mergeKeys that should be treated as condition labels (Task immediately following a `?` line). */
function collectConditionLabelKeys(program: Program): Set<string> {
  const out = new Set<string>();
  for (const trace of program.traces) {
    let pendingQuestion = false;
    for (const step of trace.steps) {
      if (step.kind === "Question") {
        pendingQuestion = true;
        continue;
      }
      if (step.kind === "Annotation" || step.kind === "PoolScope" || step.kind === "FragmentMarker") {
        continue;
      }
      if (pendingQuestion && (step.kind === "Task" || step.kind === "Event")) {
        out.add(step.mergeKey);
        pendingQuestion = false;
      } else {
        pendingQuestion = false;
      }
    }
  }
  return out;
}

function dataAttachmentKey(
  step: DataStep,
  pool: string,
  attachedTo: string | undefined,
  attachedInputOf: string | undefined,
): string {
  return [
    step.storeKind,
    pool,
    step.label,
    attachedTo ?? "",
    attachedInputOf ?? "",
  ].join("::");
}

/** Build ResolvedModel from program. */
function build(
  program: Program,
  parallelAnnotationsByKey: Map<string, string[]>,
): ResolvedModel {
  const ids = makeIdAllocator();
  const flowNodes = new Map<string, FlowNode>();
  const flows: SequenceFlow[] = [];
  const errors: DslError[] = [];
  const conditionLabelKeys = collectConditionLabelKeys(program);

  // Index: mergeKey → first sample step (for label/pool/kind metadata) +
  // a unioned set of boundary events / annotations / taskType across all samples
  // sharing the key. `taskType` follows the first-non-undefined-wins rule so a
  // typed mention in one trace promotes every other mention to that subtype.
  const sampleByKey = new Map<string, TaskStep | EventStep>();
  const boundariesByKey = new Map<string, EventStep[]>();
  const annotationsByKey = new Map<string, string[]>();
  const taskTypeByKey = new Map<string, TaskType>();
  const recordSample = (s: TaskStep | EventStep) => {
    if (conditionLabelKeys.has(s.mergeKey)) return;
    if (!sampleByKey.has(s.mergeKey)) sampleByKey.set(s.mergeKey, s);
    if (s.kind === "Task" && s.taskType && !taskTypeByKey.has(s.mergeKey)) {
      taskTypeByKey.set(s.mergeKey, s.taskType);
    }
    if (s.annotations.length > 0) {
      const arr = annotationsByKey.get(s.mergeKey) ?? [];
      for (const a of s.annotations) if (!arr.includes(a)) arr.push(a);
      annotationsByKey.set(s.mergeKey, arr);
    }
    if (s.kind === "Task" && s.boundary.length > 0) {
      const arr = boundariesByKey.get(s.mergeKey) ?? [];
      for (const b of s.boundary) {
        if (!arr.some((existing) => existing.mergeKey === b.mergeKey)) arr.push(b);
      }
      boundariesByKey.set(s.mergeKey, arr);
    }
  };
  for (const t of program.traces) {
    for (const s of t.steps) {
      if (s.kind === "Task" || s.kind === "Event") recordSample(s);
      if (s.kind === "Parallel") for (const lane of s.lanes) recordSample(lane);
    }
  }

  // Collect adjacency: for each ordered pair (a,b) seen anywhere, store edge label (if any).
  type Edge = { to: string; label?: string; line: number };
  const successors = new Map<string, Edge[]>();
  const predecessors = new Map<string, string[]>();
  const startKeys = new Set<string>();
  const endKeys = new Set<string>();

  // Walk paths.
  const paths = program.traces.map(tracePath);

  // Record the first line each synthetic parallel key was witnessed on, so
  // diagnostics and the inspect CLI can surface a useful source line for the
  // gateway even though the key itself is content-based.
  const parallelFirstLine = new Map<string, number>();
  for (const trace of program.traces) {
    for (const step of trace.steps) {
      if (step.kind !== "Parallel") continue;
      const splitKey = parallelSplitKey(step);
      if (!parallelFirstLine.has(splitKey)) parallelFirstLine.set(splitKey, step.line);
    }
  }

  // Resolve fragment paths: a leading-`...` fragment's first node is a target of the anchor (handled by treating anchors as graph nodes already present). Likewise trailing-`...`. The fragment's path itself contributes ordered edges among its own real steps.

  for (let pi = 0; pi < paths.length; pi++) {
    const p = paths[pi];
    const trace = program.traces[pi];
    if (p.steps.length === 0) continue;

    const realKeys = p.steps;
    if (!trace.isFragment || trace.leadingAnchor === undefined) {
      // Trace's first real step is a "start" candidate (true start only if no fragment leadingAnchor consumes it).
      if (!trace.isFragment) startKeys.add(realKeys[0].key);
    }
    if (!trace.isFragment || trace.trailingAnchor === undefined) {
      if (!trace.isFragment) endKeys.add(realKeys[realKeys.length - 1].key);
    }

    for (let i = 0; i < realKeys.length - 1; i++) {
      // skipIncoming on the *next* entry means "do not connect previous step
      // to this entry" — used to suppress the host-task → boundary edge that
      // would otherwise short-circuit the boundary's outgoing flow.
      if (realKeys[i + 1].skipIncoming) continue;
      const from = realKeys[i].key;
      const to = realKeys[i + 1].key;
      const label = p.edgeLabels.get(i);
      const arr = successors.get(from) ?? [];
      arr.push({ to, label, line: realKeys[i + 1].line });
      successors.set(from, arr);
      const pre = predecessors.get(to) ?? [];
      pre.push(from);
      predecessors.set(to, pre);
    }
  }

  // Materialise FlowNodes for every known mergeKey (including parallel synthetic nodes).
  const allKeys = new Set<string>();
  for (const k of sampleByKey.keys()) allKeys.add(k);
  for (const [k, edges] of successors.entries()) {
    allKeys.add(k);
    for (const e of edges) allKeys.add(e.to);
  }

  for (const key of allKeys) {
    if (key.startsWith("__parallel__::")) {
      const id = ids.for("Parallel", key);
      flowNodes.set(id, {
        id,
        kind: "parallelGateway",
        pool: "",
        label: "",
        annotations: parallelAnnotationsByKey.get(key) ?? [],
        sourceLine: parallelFirstLine.get(key) ?? 0,
      });
      continue;
    }
    const sample = sampleByKey.get(key);
    if (!sample) continue;
    if (sample.kind === "Event") {
      const succ = successors.get(key) ?? [];
      const pred = predecessors.get(key) ?? [];
      const positionAtStart = pred.length === 0 && startKeys.has(key);
      const positionAtEnd = succ.length === 0 && endKeys.has(key);
      const kind = classifyEventKind(sample, positionAtStart, positionAtEnd);
      const id = ids.for("Event", key);
      flowNodes.set(id, {
        id,
        kind,
        pool: sample.pool,
        label: sample.label || sample.rawInner,
        eventType: sample.eventType,
        interrupting: !sample.isDoubleParen,
        annotations: [...sample.annotations],
        sourceLine: sample.line,
      });
    } else {
      const id = ids.for("Task", key);
      flowNodes.set(id, {
        id,
        kind: "task",
        pool: sample.pool,
        label: sample.label,
        taskType: taskTypeByKey.get(key) ?? sample.taskType,
        annotations: annotationsByKey.get(key) ?? [...sample.annotations],
        sourceLine: sample.line,
      });
      // Boundary events attach to this task as separate nodes (unioned across all samples).
      const boundaries = boundariesByKey.get(key) ?? [];
      for (const b of boundaries) {
        const bid = ids.for("Boundary", `${key}::${b.rawInner}`);
        flowNodes.set(bid, {
          id: bid,
          kind: "boundaryEvent",
          pool: b.pool,
          label: b.label || b.rawInner,
          eventType: b.eventType,
          interrupting: !b.isDoubleParen,
          attachedTo: id,
          annotations: [...b.annotations],
          sourceLine: b.line,
        });
      }
    }
  }

  // Look up node id by mergeKey.
  const idForKey = (key: string): string | undefined => {
    if (key.startsWith("__parallel__::")) return ids.for("Parallel", key);
    if (key.startsWith("__boundary__::")) {
      // Synthetic key: __boundary__::<hostMergeKey>::<rawInner>
      // Boundary FlowNodes are allocated as ids.for("Boundary", `${hostKey}::${rawInner}`).
      return ids.for("Boundary", key.slice("__boundary__::".length));
    }
    const sample = sampleByKey.get(key);
    if (!sample) return undefined;
    return sample.kind === "Event" ? ids.for("Event", key) : ids.for("Task", key);
  };

  // Synthesise gateways for nodes with multiple distinct successors / predecessors.
  let flowCounter = 0;
  const newFlow = (sourceId: string, targetId: string, conditionLabel?: string): SequenceFlow => ({
    id: `Flow_${++flowCounter}`,
    sourceId,
    targetId,
    conditionLabel,
  });

  const handledForwardKeys = new Set<string>();
  for (const [fromKey, edges] of successors.entries()) {
    const sourceId = idForKey(fromKey);
    if (!sourceId) continue;
    const distinctTargets = new Map<string, Edge>();
    for (const e of edges) {
      if (!distinctTargets.has(e.to)) distinctTargets.set(e.to, e);
    }
    if (distinctTargets.size <= 1) {
      // simple sequence flow
      for (const e of distinctTargets.values()) {
        const targetId = idForKey(e.to);
        if (targetId) flows.push(newFlow(sourceId, targetId, e.label));
      }
    } else {
      // XOR split (or event-based if all targets are receive/timer events)
      const targetSamples = [...distinctTargets.keys()].map((k) => sampleByKey.get(k));
      const allEventBased = targetSamples.every(
        (s) => s && s.kind === "Event" && (START_CAPABLE.has(s.eventType) || s.eventType === "receive"),
      );
      const gwId = ids.for(allEventBased ? "EventGw" : "Gateway", fromKey);
      flowNodes.set(gwId, {
        id: gwId,
        kind: allEventBased ? "eventBasedGateway" : "exclusiveGateway",
        pool: flowNodes.get(sourceId)?.pool ?? "",
        label: "",
        annotations: [],
        sourceLine: edges[0]?.line ?? 0,
      });
      flows.push(newFlow(sourceId, gwId));
      for (const e of distinctTargets.values()) {
        const targetId = idForKey(e.to);
        if (targetId) flows.push(newFlow(gwId, targetId, e.label));
      }
    }
    handledForwardKeys.add(fromKey);
  }

  // XOR merges: nodes with multiple distinct predecessors. Fold by replacing the inbound flows with a gateway.
  for (const [toKey, preds] of predecessors.entries()) {
    const targetId = idForKey(toKey);
    if (!targetId) continue;
    const distinct = [...new Set(preds)];
    if (distinct.length <= 1) continue;
    // Find existing flows ending at targetId (from any source); collapse them via merge gateway.
    const incoming = flows.filter((f) => f.targetId === targetId);
    if (incoming.length <= 1) continue;
    const gwId = ids.for("Merge", toKey);
    flowNodes.set(gwId, {
      id: gwId,
      kind: "exclusiveGateway",
      pool: flowNodes.get(targetId)?.pool ?? "",
      label: "",
      annotations: [],
      sourceLine: flowNodes.get(targetId)?.sourceLine ?? 0,
    });
    for (const f of incoming) {
      f.targetId = gwId;
    }
    flows.push(newFlow(gwId, targetId));
  }

  // Annotate gateway question labels onto preceding gateways. For each trace, when a Question step appears, find the gateway between the preceding flow node and the next flow node; set its label.
  for (const trace of program.traces) {
    for (let i = 0; i < trace.steps.length; i++) {
      const s = trace.steps[i];
      if (s.kind !== "Question") continue;
      const before = [...trace.steps.slice(0, i)].reverse().find(isFlowStep);
      if (!before) continue;
      const sourceId = idForKey(before.mergeKey);
      if (!sourceId) continue;
      // Find gateway whose first incoming flow is from sourceId.
      const gw = [...flowNodes.values()].find(
        (n) =>
          (n.kind === "exclusiveGateway" || n.kind === "eventBasedGateway") &&
          flows.some((f) => f.sourceId === sourceId && f.targetId === n.id),
      );
      if (gw && !gw.label) gw.label = s.label;
    }
  }

  // Materialise DataObject / DataStore steps as FlowNodes.
  //
  // Spec §11.1 — "Inputs precede the consuming activity, outputs follow the
  // producing activity." A data object can therefore be:
  //   - an OUTPUT only (data step right after the producing task),
  //   - an INPUT only (data step at the start of a trace, before any task),
  //   - or BOTH (data step sitting between two tasks — e.g. canonical example
  //     5's `[db Civil Registry]` which is the output of `Register marriage`
  //     and an input to `Issue Marriage Certificate`).
  //
  // Implementation: one forward walk per trace records the upstream
  // (producing) task and a lookahead finds the next downstream (consuming)
  // task. Pool inheritance prefers the upstream pool but falls back to the
  // downstream one so data objects at trace start get the right swimlane.
  for (const trace of program.traces) {
    const steps = trace.steps;
    // Pre-compute the next flow step for each index, used both for input
    // attachment and for pool fallback.
    const nextFlowAt: Array<TaskStep | EventStep | undefined> = new Array(steps.length).fill(
      undefined,
    );
    {
      let next: TaskStep | EventStep | undefined;
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s.kind === "Task" || s.kind === "Event") next = s;
        else if (s.kind === "Parallel" && s.lanes.length > 0) next = s.lanes[0];
        else if (s.kind === "FragmentMarker") next = undefined;
        nextFlowAt[i] = next;
      }
    }

    let prevPool = "";
    let prevTaskId: string | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.kind === "Task" || step.kind === "Event") {
        prevPool = step.pool;
        prevTaskId = idForKey(step.mergeKey);
        continue;
      }
      if (step.kind === "PoolScope") {
        prevPool = step.pool;
        continue;
      }
      if (step.kind !== "Data") continue;

      const ds = step as DataStep;
      // Attribute the data node to upstream pool first; if there is none,
      // adopt the next task's pool so the node lands in the right swimlane.
      const downstream = nextFlowAt[i];
      const downstreamId = downstream ? idForKey(downstream.mergeKey) : undefined;
      const pool = prevPool || downstream?.pool || "";
      const prefix = ds.storeKind === "object" ? "DataObject" : "DataStore";
      const attachedInputOf =
        downstreamId && downstreamId !== prevTaskId ? downstreamId : undefined;
      const id = ids.for(prefix, dataAttachmentKey(ds, pool, prevTaskId, attachedInputOf));
      if (!flowNodes.has(id)) {
        flowNodes.set(id, {
          id,
          kind: ds.storeKind === "object" ? "dataObject" : "dataStore",
          pool,
          label: ds.label,
          attachedTo: prevTaskId,
          attachedInputOf,
          annotations: [],
          sourceLine: ds.line,
        });
      } else {
        // Same data id seen twice (rare): backfill attachments if missing.
        const existing = flowNodes.get(id)!;
        if (!existing.attachedTo && prevTaskId) existing.attachedTo = prevTaskId;
        if (!existing.attachedInputOf && attachedInputOf && attachedInputOf !== existing.attachedTo) {
          existing.attachedInputOf = attachedInputOf;
        }
      }
    }
  }

  // Build pool index.
  const pools: ResolvedPool[] = program.pools.map((p) => ({ name: p.name, nodeIds: [] }));
  for (const node of flowNodes.values()) {
    const target = pools.find((p) => p.name === node.pool) ?? pools[0];
    if (target) target.nodeIds.push(node.id);
  }

  // Wire parallel branches: split-gateway → each lane → join-gateway → next.
  // Without this, parallel lanes ("Task A | Task B") are orphaned in the graph.
  flowCounter = linkParallelBranches(program, flowNodes, flows, ids, flowCounter);

  // Pair send/receive events across pools into message flows.
  const messageFlows: MessageFlow[] = linkSendReceive(flowNodes);

  // Synthesise an implicit start event for any head node (no incoming flow)
  // that isn't already a start event. Sketch Miner's reference renderer does
  // the same — every trace begins with a circle even when the DSL doesn't
  // spell one out.
  synthesizeImplicitStartEvents(flowNodes, flows, pools, ids, flowCounter);

  return {
    pools,
    flowNodes,
    flows,
    messageFlows,
    errors,
  };
}

/**
 * After build(), parallel-row steps appear as a single synthetic split gateway
 * with edges `prev → split → next`. The lanes themselves (Task A, Task B in
 * `Task A | Task B`) are recorded as FlowNodes but unconnected. Wire them:
 *   - Add a join gateway.
 *   - For each lane: split → lane and lane → join.
 *   - Redirect the original `split → next` edges to start from join instead.
 */
function linkParallelBranches(
  program: Program,
  flowNodes: Map<string, FlowNode>,
  flows: SequenceFlow[],
  ids: IdAllocator,
  flowCounter: number,
): number {
  // Track which (split, lane) and (lane, join) edges we've already inserted.
  // Identical parallel rows on different lines now collide on the same split
  // and join nodes (parallelSplitKey is content-based), so without dedup we'd
  // emit the same `split → lane` flow twice — fine semantically, ugly in
  // bpmn-js. Use Sets to keep the model tight.
  const splitToLaneSeen = new Set<string>();
  const laneToJoinSeen = new Set<string>();

  for (const trace of program.traces) {
    for (const step of trace.steps) {
      if (step.kind !== "Parallel") continue;
      const splitId = ids.for("Parallel", parallelSplitKey(step));
      const splitNode = flowNodes.get(splitId);
      if (!splitNode) continue;

      const joinId = ids.for("ParallelJoin", parallelJoinKey(step));
      if (!flowNodes.has(joinId)) {
        // Inherit pool from the split (which inherits from a successor lane below).
        flowNodes.set(joinId, {
          id: joinId,
          kind: "parallelGateway",
          pool: splitNode.pool,
          label: "",
          annotations: [],
          sourceLine: step.line,
        });
      }

      const laneIds = new Set<string>();
      for (const lane of step.lanes) {
        const laneId = ids.for("Task", lane.mergeKey);
        if (!flowNodes.has(laneId)) continue;
        laneIds.add(laneId);

        const splitLaneKey = `${splitId}→${laneId}`;
        if (!splitToLaneSeen.has(splitLaneKey)) {
          splitToLaneSeen.add(splitLaneKey);
          flows.push({
            id: `Flow_${++flowCounter}`,
            sourceId: splitId,
            targetId: laneId,
          });
        }
        const laneJoinKey = `${laneId}→${joinId}`;
        if (!laneToJoinSeen.has(laneJoinKey)) {
          laneToJoinSeen.add(laneJoinKey);
          flows.push({
            id: `Flow_${++flowCounter}`,
            sourceId: laneId,
            targetId: joinId,
          });
        }

        // Pool inheritance: ensure the gateway sits in the lane's pool if split.pool was empty.
        if (!splitNode.pool) splitNode.pool = flowNodes.get(laneId)!.pool;
        const joinNode = flowNodes.get(joinId)!;
        if (!joinNode.pool) joinNode.pool = flowNodes.get(laneId)!.pool;
      }

      // Redirect any pre-existing `split → X` (non-lane) flows to start from join.
      for (const f of flows) {
        if (f.sourceId === splitId && !laneIds.has(f.targetId)) {
          f.sourceId = joinId;
        }
      }
    }
  }

  // Drop orphan split/join gateways. A parallel row can be:
  //   - SPLIT only — lanes diverge into fragments (canon-1 line 3). The split
  //     has incoming from the trace predecessor; the join has nothing
  //     downstream (the lanes proceed via fragment continuations).
  //   - JOIN only — lanes converge before a single successor (canon-1 lines
  //     31 & 38). The split has no upstream; the join has the trace
  //     continuation as its outgoing.
  //   - SPLIT-AND-JOIN — both ends connect (rare; the redirect loop above
  //     already wires the join's outgoing).
  // Emitting both gateways unconditionally produced canon-1's "5 gateways
  // with 3 orphans" issue against the 3-gateway reference.
  const splitOrJoinKinds = new Set<string>();
  for (const trace of program.traces) {
    for (const step of trace.steps) {
      if (step.kind !== "Parallel") continue;
      splitOrJoinKinds.add(ids.for("Parallel", parallelSplitKey(step)));
      splitOrJoinKinds.add(ids.for("ParallelJoin", parallelJoinKey(step)));
    }
  }
  const dropIds = new Set<string>();
  for (const id of splitOrJoinKinds) {
    const node = flowNodes.get(id);
    if (!node || node.kind !== "parallelGateway") continue;
    const hasIncoming = flows.some((f) => f.targetId === id);
    const hasOutgoing = flows.some((f) => f.sourceId === id);
    // Splits get edges OUT to each lane in the same parallel row, so
    // hasOutgoing alone is not a sign of being needed; the discriminator is
    // hasIncoming. Mirror for joins. Strictly: a parallelGateway with no
    // incoming AND no non-lane outgoing is an orphan; ditto for the join.
    // Practically each parallel id fits exactly one role (the id namespaces
    // are distinct: "Parallel" vs "ParallelJoin"), so:
    //   - "Parallel"     → drop iff !hasIncoming
    //   - "ParallelJoin" → drop iff !hasOutgoing
    if (id.startsWith("Parallel_") && !id.startsWith("ParallelJoin_") && !hasIncoming) {
      dropIds.add(id);
    } else if (id.startsWith("ParallelJoin_") && !hasOutgoing) {
      dropIds.add(id);
    }
  }
  if (dropIds.size > 0) {
    // Strip the orphan gateways and any flows touching them.
    for (let i = flows.length - 1; i >= 0; i--) {
      const f = flows[i];
      if (dropIds.has(f.sourceId) || dropIds.has(f.targetId)) flows.splice(i, 1);
    }
    for (const id of dropIds) flowNodes.delete(id);
  }

  return flowCounter;
}

function synthesizeImplicitStartEvents(
  flowNodes: Map<string, FlowNode>,
  flows: SequenceFlow[],
  pools: ResolvedPool[],
  ids: IdAllocator,
  flowCounterStart: number,
): void {
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const f of flows) {
    incomingCount.set(f.targetId, (incomingCount.get(f.targetId) ?? 0) + 1);
    outgoingCount.set(f.sourceId, (outgoingCount.get(f.sourceId) ?? 0) + 1);
  }
  let nextFlow = flowCounterStart;
  for (const node of [...flowNodes.values()]) {
    if (node.kind === "startEvent" || node.kind === "boundaryEvent") continue;
    if (node.kind === "dataObject" || node.kind === "dataStore") continue;
    if ((incomingCount.get(node.id) ?? 0) > 0) continue;
    // Gateways are synthesized; if one already routes outgoing flows it cannot
    // legitimately need an implicit start. Without this guard the trailing
    // parallel-join in canon-1 ("Slide sandwich down heated chute" merging with
    // "Ensure fresh batch of fries is ready") gets a stray StartEvent because
    // its lane-end inputs feed the join via `split → lane → join` rewiring,
    // not direct sequence flows.
    if (
      (node.kind === "exclusiveGateway" ||
        node.kind === "parallelGateway" ||
        node.kind === "eventBasedGateway") &&
      (outgoingCount.get(node.id) ?? 0) > 0
    ) {
      continue;
    }
    const startId = ids.for("StartEvent", `implicit::${node.id}`);
    flowNodes.set(startId, {
      id: startId,
      kind: "startEvent",
      pool: node.pool,
      label: "",
      annotations: [],
      sourceLine: node.sourceLine,
    });
    const target = pools.find((p) => p.name === node.pool);
    if (target) target.nodeIds.push(startId);
    nextFlow++;
    flows.push({
      id: `Flow_${nextFlow}`,
      sourceId: startId,
      targetId: node.id,
    });
  }
}

/** Match `send X` to `receive X` / `received X` across distinct pools by label. */
function linkSendReceive(flowNodes: Map<string, FlowNode>): MessageFlow[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const senders: FlowNode[] = [];
  const receivers: FlowNode[] = [];
  for (const n of flowNodes.values()) {
    if (n.eventType === "send") senders.push(n);
    else if (n.eventType === "receive" || n.eventType === "received") receivers.push(n);
  }
  const out: MessageFlow[] = [];
  let counter = 0;
  for (const s of senders) {
    const sKey = norm(s.label);
    if (!sKey) continue;
    for (const r of receivers) {
      if (r.pool === s.pool) continue;
      if (norm(r.label) !== sKey) continue;
      out.push({
        id: `MessageFlow_${++counter}`,
        sourceId: s.id,
        targetId: r.id,
        label: s.label,
      });
    }
  }
  return out;
}

export function resolve(program: Program): ResolvedModel {
  const parallelAnnotationsByKey = new Map<string, string[]>();
  attachAnnotations(program, parallelAnnotationsByKey);
  attachBoundaryEvents(program);
  applyPoolFirstMention(program);
  detectAnchorViolations(program);
  return build(program, parallelAnnotationsByKey);
}
