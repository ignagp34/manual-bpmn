import { CstParser, type CstNode, type IToken } from "chevrotain";
import {
  type AnnotationStep,
  type DataStep,
  type DslError,
  type EventStep,
  type FragmentMarkerStep,
  type GatewayQuestionStep,
  type ParallelStep,
  type Pool,
  type PoolScopeStep,
  type Program,
  type Step,
  type TaskStep,
  type Trace,
} from "./ast.js";
import { ALL_TOKENS, T, tokenize, type LinePayload, type LineToken } from "./lexer.js";

class DslParser extends CstParser {
  constructor() {
    super(ALL_TOKENS, { recoveryEnabled: true });
    this.performSelfAnalysis();
  }

  public program = this.RULE("program", () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(T.Blank) },
        { ALT: () => this.SUBRULE(this.trace) },
      ]);
    });
  });

  private trace = this.RULE("trace", () => {
    this.AT_LEAST_ONE(() => this.SUBRULE(this.traceLine));
  });

  private traceLine = this.RULE("traceLine", () => {
    this.OR([
      { ALT: () => this.CONSUME(T.PoolDefault) },
      { ALT: () => this.CONSUME(T.Annotation) },
      { ALT: () => this.CONSUME(T.Task) },
      { ALT: () => this.CONSUME(T.Event) },
      { ALT: () => this.CONSUME(T.Data) },
      { ALT: () => this.CONSUME(T.GatewayQuestion) },
      { ALT: () => this.CONSUME(T.Parallel) },
      { ALT: () => this.CONSUME(T.FragmentMarker) },
    ]);
  });
}

const parserInstance = new DslParser();

function mergeKey(pool: string, label: string): string {
  return `${pool}::${label}`;
}

function payloadToStep(
  payload: LinePayload,
  line: number,
  defaultPool: string,
  currentLane: string,
): { step: Step | null; nextDefaultPool: string; nextCurrentLane: string } {
  switch (payload.kind) {
    case "Blank":
      return { step: null, nextDefaultPool: defaultPool, nextCurrentLane: currentLane };
    case "Annotation": {
      const step: AnnotationStep = { kind: "Annotation", text: payload.text, line };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: currentLane };
    }
    case "PoolDefault": {
      const step: PoolScopeStep = { kind: "PoolScope", pool: payload.pool, line };
      return { step, nextDefaultPool: payload.pool, nextCurrentLane: payload.pool };
    }
    case "FragmentMarker": {
      const step: FragmentMarkerStep = { kind: "FragmentMarker", line };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: currentLane };
    }
    case "Task": {
      const pool = payload.pool ?? currentLane;
      const annotations = payload.inlineAnnotation ? [payload.inlineAnnotation] : [];
      const step: TaskStep = {
        kind: "Task",
        pool,
        label: payload.label,
        taskType: payload.taskType,
        mergeKey: mergeKey(pool, payload.label),
        line,
        annotations,
        boundary: [],
      };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: pool };
    }
    case "Event": {
      const pool = payload.pool ?? currentLane;
      const label = payload.label || payload.eventType;
      const step: EventStep = {
        kind: "Event",
        pool,
        eventType: payload.eventType,
        label,
        rawInner: payload.rawInner,
        mergeKey: mergeKey(pool, payload.rawInner),
        isDoubleParen: payload.isDoubleParen,
        line,
        annotations: [],
      };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: pool };
    }
    case "Data": {
      const step: DataStep = {
        kind: "Data",
        storeKind: payload.storeKind,
        label: payload.label,
        line,
      };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: currentLane };
    }
    case "GatewayQuestion": {
      const step: GatewayQuestionStep = { kind: "Question", label: payload.label, line };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: currentLane };
    }
    case "Parallel": {
      const pool = payload.pool ?? currentLane;
      const lanes: TaskStep[] = payload.lanes.map((lane) => {
        const lanePool = lane.pool ?? pool;
        return {
          kind: "Task",
          pool: lanePool,
          label: lane.label,
          taskType: lane.taskType,
          mergeKey: mergeKey(lanePool, lane.label),
          line,
          annotations: [],
          boundary: [],
        };
      });
      const lastLanePool = lanes.length > 0 ? lanes[lanes.length - 1].pool : pool;
      const step: ParallelStep = { kind: "Parallel", lanes, line };
      return { step, nextDefaultPool: defaultPool, nextCurrentLane: lastLanePool };
    }
  }
}

function tokenLine(node: CstNode | IToken): number {
  if ("startLine" in node && node.startLine !== undefined) return node.startLine;
  return 0;
}

function collectTokensInOrder(node: CstNode): IToken[] {
  const out: IToken[] = [];
  const visit = (n: CstNode) => {
    const childKeys = Object.keys(n.children);
    const allChildren: Array<CstNode | IToken> = [];
    for (const k of childKeys) {
      for (const c of n.children[k]!) allChildren.push(c as CstNode | IToken);
    }
    allChildren.sort((a, b) => tokenLine(a) - tokenLine(b));
    for (const c of allChildren) {
      if ("name" in c && "children" in c) visit(c as CstNode);
      else out.push(c as IToken);
    }
  };
  visit(node);
  return out;
}

function buildTraceFromTokens(tokens: LineToken[], defaultPool: string): { trace: Trace; nextDefaultPool: string } {
  const steps: Step[] = [];
  let runningDefault = defaultPool;
  let lane = defaultPool;
  for (const tok of tokens) {
    const { step, nextDefaultPool, nextCurrentLane } = payloadToStep(
      tok.payload,
      tok.startLine ?? 0,
      runningDefault,
      lane,
    );
    if (step) steps.push(step);
    runningDefault = nextDefaultPool;
    lane = nextCurrentLane;
  }

  const startLine = tokens[0]?.startLine ?? 0;
  const endLine = tokens[tokens.length - 1]?.startLine ?? startLine;

  // Detect fragment boundaries. Skip leading/trailing PoolScope and Annotation steps when locating markers.
  const realIdx: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const k = steps[i].kind;
    if (k !== "PoolScope" && k !== "Annotation") realIdx.push(i);
  }
  let isFragment = false;
  let leadingAnchor: string | undefined;
  let trailingAnchor: string | undefined;
  if (realIdx.length > 0) {
    const first = steps[realIdx[0]];
    const last = steps[realIdx[realIdx.length - 1]];
    if (first.kind === "FragmentMarker") {
      isFragment = true;
      const after = realIdx.slice(1).map((i) => steps[i]).find((s) => s.kind === "Task" || s.kind === "Event");
      if (after && (after.kind === "Task" || after.kind === "Event")) {
        leadingAnchor = after.mergeKey;
      }
    }
    if (last.kind === "FragmentMarker") {
      isFragment = true;
      const before = realIdx.slice(0, -1).reverse().map((i) => steps[i]).find((s) => s.kind === "Task" || s.kind === "Event");
      if (before && (before.kind === "Task" || before.kind === "Event")) {
        trailingAnchor = before.mergeKey;
      }
    }
  }

  return {
    trace: { startLine, endLine, steps, isFragment, leadingAnchor, trailingAnchor },
    nextDefaultPool: runningDefault,
  };
}

function applyFallbackPoolToTrace(trace: Trace, pool: string): void {
  for (const step of trace.steps) {
    if (step.kind === "Task" && !step.pool) {
      step.pool = pool;
      step.mergeKey = mergeKey(pool, step.label);
      continue;
    }
    if (step.kind === "Event" && !step.pool) {
      step.pool = pool;
      step.mergeKey = mergeKey(pool, step.rawInner);
      continue;
    }
    if (step.kind !== "Parallel") continue;
    for (const lane of step.lanes) {
      if (lane.pool) continue;
      lane.pool = pool;
      lane.mergeKey = mergeKey(pool, lane.label);
    }
  }

  if (!trace.isFragment) return;
  const real = trace.steps.filter((s) => s.kind === "Task" || s.kind === "Event" || s.kind === "FragmentMarker");
  if (real.length === 0) return;
  if (real[0].kind === "FragmentMarker") {
    const after = real.find((s) => s.kind === "Task" || s.kind === "Event");
    if (after && (after.kind === "Task" || after.kind === "Event")) {
      trace.leadingAnchor = after.mergeKey;
    }
  }
  if (real[real.length - 1].kind === "FragmentMarker") {
    const before = [...real].reverse().find((s) => s.kind === "Task" || s.kind === "Event");
    if (before && (before.kind === "Task" || before.kind === "Event")) {
      trace.trailingAnchor = before.mergeKey;
    }
  }
}

function mapChevrotainErrors(
  errs: ReturnType<typeof parserInstance.errors.slice>,
): DslError[] {
  return errs.map((e) => ({
    line: e.token?.startLine ?? 1,
    column: e.token?.startColumn,
    code: "PARSE-1",
    severity: "error",
    message: e.message,
  }));
}

export function parse(source: string): Program {
  const lex = tokenize(source);
  const errors: DslError[] = [...lex.errors];

  parserInstance.input = lex.tokens;
  const cst = parserInstance.program();
  errors.push(...mapChevrotainErrors(parserInstance.errors));

  const traces: Trace[] = [];
  const pools: Pool[] = [];
  const seenPools = new Set<string>();
  let defaultPool = "";

  const recordPool = (name: string, line: number) => {
    if (!name) return;
    if (!seenPools.has(name)) {
      seenPools.add(name);
      pools.push({ name, firstSeenLine: line });
    }
  };

  const traceNodes = (cst.children["trace"] ?? []) as CstNode[];
  for (const traceNode of traceNodes) {
    const tokens = collectTokensInOrder(traceNode) as LineToken[];
    if (tokens.length === 0) continue;
    const built = buildTraceFromTokens(tokens, defaultPool);
    defaultPool = built.nextDefaultPool;
    for (const s of built.trace.steps) {
      if (s.kind === "PoolScope") recordPool(s.pool, s.line);
      if (s.kind === "Task" || s.kind === "Event") recordPool(s.pool, s.line);
      if (s.kind === "Parallel") for (const lane of s.lanes) recordPool(lane.pool, lane.line);
    }
    traces.push(built.trace);
  }

  if (pools.length === 0) {
    const fallbackPool = "Pool_1";
    for (const trace of traces) applyFallbackPoolToTrace(trace, fallbackPool);
    pools.push({ name: fallbackPool, firstSeenLine: 1 });
  }

  return { pools, traces, errors };
}
