import type { DslError, ResolvedModel } from "@text-to-bpmn/core";
import type { BpmnValidationFinding, BpmnValidationResult } from "@text-to-bpmn/core";
import type {
  DiagnosticCategory,
  DslEvaluationOutcome,
  ExperimentBundleAsset,
  ExperimentDiagnostic,
  ExperimentEvaluationResult,
  ExperimentMetadata,
  ExperimentMetrics,
  ExperimentStatus,
} from "./types.js";

const PARSER_CODES = new Set(["LEX-1", "PARSE-1"]);
const DSL_ONLY_SUFFIX = "Return only the BPMN Sketch Miner DSL output, without explanations.";

export function normalizeExperimentIdSegment(value: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "UNKNOWN";
}

export function generateExperimentId(input: {
  modelLabel: string;
  processId: string;
  provider: string;
  runNumber: number;
  systemPromptVersion: string;
}): string {
  const run = Math.max(0, Math.trunc(input.runNumber)).toString().padStart(2, "0");
  return [
    "EXP",
    normalizeExperimentIdSegment(input.processId),
    normalizeExperimentIdSegment(input.systemPromptVersion),
    normalizeExperimentIdSegment(input.provider),
    normalizeExperimentIdSegment(input.modelLabel),
    `R${run}`,
  ].join("-");
}

export function buildFinalPrompt(systemPromptText: string, processPromptText: string): string {
  return [systemPromptText.trim(), processPromptText.trim(), DSL_ONLY_SUFFIX]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

export function normalizeDslOutput(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced !== null) {
    return fenced[1].trim();
  }
  return trimmed;
}

export function classifyDslDiagnostic(err: DslError): ExperimentDiagnostic {
  const category: DiagnosticCategory = PARSER_CODES.has(err.code) ? "parser" : "semantic";
  return {
    category,
    code: err.code,
    line: err.line,
    message: err.message,
    severity: err.severity,
    source: "dsl",
  };
}

export function makeRenderDiagnostic(code: string, message: string): ExperimentDiagnostic {
  return {
    category: "render",
    code,
    message,
    severity: "error",
    source: "render",
  };
}

export function renderWarningToDiagnostic(warning: unknown, index: number): ExperimentDiagnostic {
  return {
    category: "render",
    code: `RENDER-WARN-${index + 1}`,
    message: warningMessage(warning),
    severity: "warning",
    source: "render",
  };
}

export function bpmnValidationFindingToDiagnostic(finding: BpmnValidationFinding): ExperimentDiagnostic {
  return {
    category: "bpmn",
    code: finding.code,
    message: finding.elementName
      ? `${finding.message} (${finding.elementName})`
      : finding.message,
    severity: finding.severity,
    source: "validation",
  };
}

export function bpmnValidationToDiagnostics(
  validation: BpmnValidationResult,
  options: { origins?: Array<BpmnValidationFinding["origin"]> } = {},
): ExperimentDiagnostic[] {
  const origins = options.origins === undefined ? undefined : new Set(options.origins);
  return [...validation.errors, ...validation.warnings, ...validation.info]
    .filter((finding) => origins === undefined || origins.has(finding.origin))
    .map(bpmnValidationFindingToDiagnostic);
}

export function determineExperimentStatus(
  parserErrors: ExperimentDiagnostic[],
  semanticErrors: ExperimentDiagnostic[],
  semanticWarnings: ExperimentDiagnostic[],
  renderErrors: ExperimentDiagnostic[],
  bpmnValidation?: BpmnValidationResult,
): ExperimentStatus {
  if (parserErrors.length > 0) return "parser_error";
  if (semanticErrors.length > 0) return "semantic_error";
  if (renderErrors.length > 0) return "render_error";
  if (
    bpmnValidation !== undefined &&
    [...bpmnValidation.errors, ...bpmnValidation.warnings].some(
      (finding) => finding.origin === "model",
    )
  ) {
    return "success_with_warnings";
  }
  if (semanticWarnings.length > 0) return "success_with_warnings";
  return "success";
}

export function buildManifestRow(
  metadata: ExperimentMetadata,
  bpmnValidation?: BpmnValidationResult,
): string {
  const fields = [
    metadata.experimentId,
    metadata.processId,
    metadata.processSource,
    metadata.systemPromptVersion,
    metadata.processPromptVersion,
    metadata.provider,
    metadata.modelLabel,
    metadata.interfaceType,
    String(metadata.runNumber),
    metadata.createdAt.slice(0, 10),
    metadata.inputPromptHash,
    metadata.rawOutputHash,
    metadata.normalizedDslHash,
    metadata.status,
    bpmnValidation?.status ?? "",
    String(bpmnValidation?.errors.length ?? 0),
    String(bpmnValidation?.warnings.length ?? 0),
  ];
  return fields.map(csvEscape).join(",");
}

export function buildExperimentBundle(result: ExperimentEvaluationResult): ExperimentBundleAsset[] {
  const assets: ExperimentBundleAsset[] = [
    { filename: "input_prompt.md", data: result.inputPrompt, mime: "text/markdown;charset=utf-8" },
    { filename: "raw_output.txt", data: result.rawOutput, mime: "text/plain;charset=utf-8" },
    { filename: "normalized_dsl.txt", data: result.normalizedDsl, mime: "text/plain;charset=utf-8" },
    {
      filename: "result.json",
      data: JSON.stringify(result, null, 2),
      mime: "application/json;charset=utf-8",
    },
    { filename: "notes.md", data: result.notes, mime: "text/markdown;charset=utf-8" },
  ];

  if (result.layoutXml !== undefined) {
    assets.push({
      filename: "diagram.bpmn",
      data: result.layoutXml,
      mime: "application/xml;charset=utf-8",
    });
  }

  return assets;
}

export function buildExperimentResult(input: {
  appVersion: string;
  evaluatedAt: string;
  inputPrompt: string;
  metadata: ExperimentMetadata;
  notes: string;
  normalizedDsl: string;
  outcome: DslEvaluationOutcome;
  rawOutput: string;
  svgAvailable: boolean;
  pngAvailable: boolean;
}): ExperimentEvaluationResult {
  const metrics = collectMetrics(input.outcome.model, input.outcome.layoutXml);
  return {
    metadata: input.metadata,
    bpmnValidation: input.outcome.bpmnValidation,
    diagnostics: input.outcome.diagnostics,
    parserErrors: input.outcome.parserErrors,
    semanticErrors: input.outcome.semanticErrors,
    semanticWarnings: input.outcome.semanticWarnings,
    renderErrors: input.outcome.renderErrors,
    exportAvailability: {
      bpmn: input.outcome.layoutXml !== undefined,
      png: input.pngAvailable,
      resultJson: true,
      svg: input.svgAvailable,
    },
    timestamps: {
      createdAt: input.metadata.createdAt,
      evaluatedAt: input.evaluatedAt,
    },
    versions: {
      appVersion: input.appVersion,
      parserVersion: input.appVersion,
    },
    metrics,
    inputPrompt: input.inputPrompt,
    rawOutput: input.rawOutput,
    normalizedDsl: input.normalizedDsl,
    notes: input.notes,
    semanticXml: input.outcome.semanticXml,
    layoutXml: input.outcome.layoutXml,
  };
}

export function collectMetrics(
  model: ResolvedModel | undefined,
  layoutXml: string | undefined,
): ExperimentMetrics {
  const nodes = model === undefined ? [] : Array.from(model.flowNodes.values());
  return {
    tasks: nodes.filter((node) => node.kind === "task").length,
    events: nodes.filter((node) =>
      node.kind === "startEvent" ||
      node.kind === "endEvent" ||
      node.kind === "intermediateEvent" ||
      node.kind === "boundaryEvent",
    ).length,
    gateways: nodes.filter((node) =>
      node.kind === "exclusiveGateway" ||
      node.kind === "parallelGateway" ||
      node.kind === "eventBasedGateway",
    ).length,
    participants: model?.pools.length ?? 0,
    lanes: countXmlElements(layoutXml, "bpmn:lane"),
    sequenceFlows: model?.flows.length ?? 0,
    messageFlows: model?.messageFlows.length ?? 0,
    dataObjects: nodes.filter((node) => node.kind === "dataObject" || node.kind === "dataStore").length,
    textAnnotations: nodes.reduce((count, node) => count + node.annotations.length, 0),
    diagonalEdgesDetected: detectDiagonalEdges(layoutXml),
  };
}

function countXmlElements(xml: string | undefined, tagName: string): number {
  if (xml === undefined) return 0;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return doc.getElementsByTagName(tagName).length;
}

function detectDiagonalEdges(xml: string | undefined): boolean {
  if (xml === undefined) return false;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const edges = Array.from(doc.getElementsByTagName("di:waypoint"));
  for (let index = 0; index < edges.length - 1; index += 1) {
    const current = edges[index];
    const next = edges[index + 1];
    if (current.parentElement !== next.parentElement) continue;
    const x1 = Number(current.getAttribute("x"));
    const y1 = Number(current.getAttribute("y"));
    const x2 = Number(next.getAttribute("x"));
    const y2 = Number(next.getAttribute("y"));
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    if (x1 !== x2 && y1 !== y2) {
      return true;
    }
  }
  return false;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function warningMessage(warning: unknown): string {
  if (warning instanceof Error && warning.message.length > 0) {
    return warning.message;
  }
  if (
    typeof warning === "object" &&
    warning !== null &&
    "message" in warning &&
    typeof warning.message === "string" &&
    warning.message.length > 0
  ) {
    return warning.message;
  }
  return `Renderer warning: ${String(warning)}`;
}
