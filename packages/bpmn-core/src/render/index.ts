import { layoutProcess } from "bpmn-auto-layout";
import type BpmnModeler from "bpmn-js/lib/Modeler";

import type { ResolvedModel } from "../dsl/ast.js";
import { sanitizeForLayout } from "./sanitize.js";
import { layoutMissingProcesses } from "./layout-missing.js";
import { placeArtifacts } from "./artifacts.js";
import { placePoolsAndLanes, extendOuterLanes } from "./pools.js";
import { orthogonalize } from "./orthogonal.js";
import { distributeParallelChannels } from "./edge-channels.js";
import { placeLabels } from "./labels.js";

export interface RenderOptions {
  /** Vertical stride between lane rows. Default 80. */
  laneGrid?: number;
}

export interface RenderResult {
  layoutXml: string;
  warnings: unknown[];
}

/**
 * Run the M4 render pipeline:
 *   1. sanitize semantic XML for bpmn-auto-layout
 *   2. bpmn-auto-layout (with degraded fallback on crash)
 *   3. place pool/lane shapes + seed message-flow edges
 *   4. orthogonalize control flow
 *   5. place data refs / annotations in local whitespace near attached nodes
 *   6. importXML into the supplied modeler and zoom to fit
 *
 * Steps 3–5 land in subsequent commits; for now this owns Step 2 (extraction)
 * with Step 3+ as no-op pass-throughs so main.ts becomes a thin shell today.
 */
export async function renderSemanticXml(
  modeler: BpmnModeler,
  semanticXml: string,
  _model: ResolvedModel,
  _opts: RenderOptions = {},
): Promise<RenderResult> {
  const cleaned = await sanitizeForLayout(semanticXml);
  let layoutXml: string;
  try {
    layoutXml = await layoutProcess(cleaned);
  } catch (err) {
    // Sanitizer covers the boundary-event `.reverse()` crash; if a different
    // shape still crashes layoutProcess, surface it loudly so we can extend
    // the sanitizer rather than silently degrade.
    throw new Error(`bpmn-auto-layout failed: ${(err as Error).message}`);
  }
  layoutXml = await layoutMissingProcesses(layoutXml);
  layoutXml = await placePoolsAndLanes(layoutXml);
  layoutXml = await orthogonalize(layoutXml);
  layoutXml = await distributeParallelChannels(layoutXml);
  layoutXml = await placeLabels(layoutXml);
  layoutXml = await extendOuterLanes(layoutXml);
  layoutXml = await placeArtifacts(layoutXml);
  const { warnings } = await modeler.importXML(layoutXml);
  const canvas = modeler.get<{ zoom: (level: string) => void }>("canvas");
  canvas.zoom("fit-viewport");
  return { layoutXml, warnings };
}
