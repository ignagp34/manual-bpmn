export type DslErrorCode =
  | "LEX-1"
  | "PARSE-1"
  | "AP-6"
  | "AP-7"
  | "ANCHOR-MISSING"
  | "INLINE-COMMENT"
  | "FRAGMENT-OPEN"
  | "FRAGMENT-DUP"
  | "DANGLING-QUESTION";

export type DslError = {
  line: number;
  column?: number;
  code: DslErrorCode;
  severity: "error" | "warning";
  message: string;
};

export type TaskType = "user" | "service" | "rule" | "manual" | "receive" | "send" | "script";

export type EventSubtype =
  | "start"
  | "finish"
  | "end"
  | "timer"
  | "deadline"
  | "exception"
  | "received"
  | "receive"
  | "send"
  | "escalated"
  | "escalate"
  | "message"
  | "signal"
  | "error"
  | "terminate"
  | "link"
  | "publish"
  | "notify"
  | "unknown";

export type Pool = {
  name: string;
  firstSeenLine: number;
};

export type TaskStep = {
  kind: "Task";
  pool: string;
  label: string;
  taskType?: TaskType;
  mergeKey: string;
  line: number;
  annotations: string[];
  boundary: EventStep[];
};

export type EventStep = {
  kind: "Event";
  pool: string;
  eventType: EventSubtype;
  label: string;
  rawInner: string;
  mergeKey: string;
  isDoubleParen: boolean;
  line: number;
  annotations: string[];
};

export type DataStep = {
  kind: "Data";
  storeKind: "object" | "store";
  label: string;
  line: number;
};

export type GatewayQuestionStep = {
  kind: "Question";
  label: string;
  line: number;
};

export type ParallelStep = {
  kind: "Parallel";
  lanes: TaskStep[];
  line: number;
};

export type PoolScopeStep = {
  kind: "PoolScope";
  pool: string;
  line: number;
};

export type AnnotationStep = {
  kind: "Annotation";
  text: string;
  line: number;
};

export type FragmentMarkerStep = {
  kind: "FragmentMarker";
  line: number;
};

export type Step =
  | TaskStep
  | EventStep
  | DataStep
  | GatewayQuestionStep
  | ParallelStep
  | PoolScopeStep
  | AnnotationStep
  | FragmentMarkerStep;

export type Trace = {
  startLine: number;
  endLine: number;
  steps: Step[];
  isFragment: boolean;
  leadingAnchor?: string;
  trailingAnchor?: string;
  /**
   * Step → mergeKey of the boundary event whose firing leads to that step.
   * Populated by attachBoundaryEvents when a `(deadline …)` / `(exception …)` /
   * `(received …)` / `(escalated …)` line appears between two flow steps in
   * the same trace. The downstream step's incoming flow then sources from the
   * boundary instead of from the host task. Without this, a deadline boundary
   * with no following step in the trace ends up with `outgoing = undefined`,
   * which crashes bpmn-auto-layout 0.5.0 (`attachersHandler.js:15`).
   */
  boundaryEdgeOverride?: Map<TaskStep | EventStep, string>;
};

export type Program = {
  pools: Pool[];
  traces: Trace[];
  errors: DslError[];
};

export type FlowNodeKind =
  | "task"
  | "startEvent"
  | "endEvent"
  | "intermediateEvent"
  | "boundaryEvent"
  | "exclusiveGateway"
  | "parallelGateway"
  | "eventBasedGateway"
  | "dataObject"
  | "dataStore";

export type FlowNode = {
  id: string;
  kind: FlowNodeKind;
  pool: string;
  label: string;
  eventType?: EventSubtype;
  taskType?: TaskType;
  interrupting?: boolean;
  attachedTo?: string;
  /** For data objects/stores attached as input as well as output, list both task ids. */
  attachedInputOf?: string;
  annotations: string[];
  sourceLine: number;
};

export type SequenceFlow = {
  id: string;
  sourceId: string;
  targetId: string;
  conditionLabel?: string;
};

export type MessageFlow = {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
};

export type ResolvedPool = {
  name: string;
  nodeIds: string[];
};

export type ResolvedModel = {
  pools: ResolvedPool[];
  flowNodes: Map<string, FlowNode>;
  flows: SequenceFlow[];
  messageFlows: MessageFlow[];
  errors: DslError[];
};

export type ParseResult = {
  program: Program;
  model: ResolvedModel;
  errors: DslError[];
};
