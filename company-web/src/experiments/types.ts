import type { DslError, ResolvedModel } from "@text-to-bpmn/core";
import type { BpmnValidationResult } from "@text-to-bpmn/core";

export type ExperimentProvider = "ChatGPT" | "Gemini" | "Claude" | "Other";

export type ExperimentStatus =
  | "draft"
  | "success"
  | "success_with_warnings"
  | "parser_error"
  | "semantic_error"
  | "render_error";

export type DiagnosticCategory = "parser" | "semantic" | "render" | "bpmn" | "ui";

export type ExperimentDiagnostic = {
  category: DiagnosticCategory;
  code: string;
  line?: number;
  message: string;
  severity: "error" | "warning" | "info";
  source: "dsl" | "render" | "validation" | "ui";
};

export type ExperimentMetadata = {
  experimentId: string;
  processId: string;
  processSource: string;
  systemPromptVersion: string;
  processPromptVersion: string;
  provider: string;
  modelLabel: string;
  interfaceType: "web";
  runNumber: number;
  createdAt: string;
  inputPromptHash: string;
  rawOutputHash: string;
  normalizedDslHash: string;
  parserValid: boolean;
  semanticValid: boolean;
  bpmnImportValid: boolean;
  renderValid: boolean;
  status: ExperimentStatus;
  notes: string;
};

export type ExperimentMetrics = {
  tasks: number;
  events: number;
  gateways: number;
  participants: number;
  lanes: number;
  sequenceFlows: number;
  messageFlows: number;
  dataObjects: number;
  textAnnotations: number;
  diagonalEdgesDetected: boolean;
};

export type ExportAvailability = {
  bpmn: boolean;
  png: boolean;
  resultJson: boolean;
  svg: boolean;
};

export type ExperimentEvaluationResult = {
  metadata: ExperimentMetadata;
  bpmnValidation: BpmnValidationResult;
  diagnostics: ExperimentDiagnostic[];
  parserErrors: ExperimentDiagnostic[];
  semanticErrors: ExperimentDiagnostic[];
  semanticWarnings: ExperimentDiagnostic[];
  renderErrors: ExperimentDiagnostic[];
  exportAvailability: ExportAvailability;
  timestamps: {
    createdAt: string;
    evaluatedAt: string;
  };
  versions: {
    appVersion: string;
    parserVersion: string;
  };
  metrics: ExperimentMetrics;
  inputPrompt: string;
  rawOutput: string;
  normalizedDsl: string;
  notes: string;
  semanticXml?: string;
  layoutXml?: string;
};

export type ExperimentDraft = {
  activeTab: "editor" | "experiments";
  createdAt: string;
  interfaceType: "web";
  modelLabel: string;
  notes: string;
  processId: string;
  processPromptText: string;
  processPromptVersion: string;
  processSelection: string;
  processSource: string;
  provider: ExperimentProvider;
  rawOutput: string;
  runNumber: number;
  selectedSystemPrompt: string;
  systemPromptText: string;
  systemPromptVersion: string;
};

export type ExperimentBundleAsset = {
  data: BlobPart;
  filename: string;
  mime: string;
};

export type ProcessCorpusEntry = {
  difficulty?: string;
  expected_features?: string[];
  filename: string;
  process_id: string;
  process_source?: string;
  short_description?: string;
  title?: string;
};

export type ProcessPromptDefinition = ProcessCorpusEntry & {
  promptText: string;
};

export type SystemPromptDefinition = {
  id: string;
  label: string;
  text: string;
  versionHint: string;
};

export type ExperimentLibrary = {
  corpusAvailable: boolean;
  processes: ProcessPromptDefinition[];
  systemPrompts: SystemPromptDefinition[];
};

export type DslEvaluationOutcome = {
  bpmnValidation: BpmnValidationResult;
  diagnostics: ExperimentDiagnostic[];
  errorDiagnostics: ExperimentDiagnostic[];
  lastGoodDiagramRetained: boolean;
  layoutXml?: string;
  model?: ResolvedModel;
  parserErrors: ExperimentDiagnostic[];
  parseErrors: DslError[];
  rawWarnings: unknown[];
  renderErrors: ExperimentDiagnostic[];
  semanticErrors: ExperimentDiagnostic[];
  semanticWarnings: ExperimentDiagnostic[];
  semanticXml?: string;
  succeeded: boolean;
};
