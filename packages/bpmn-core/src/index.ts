/// <reference path="./ambient.d.ts" />

/**
 * @text-to-bpmn/core — public API surface.
 *
 * Both `apps/tfm-lab` and `apps/company-web` import from this barrel only.
 * Engine modules (dsl/, bpmn/, render/, validation/) are implementation
 * detail and should not be imported directly by app code.
 */

import { parseDsl } from "./dsl/index.js";
import { emitBpmnXml } from "./bpmn/emit.js";
import { renderSemanticXml, type RenderResult } from "./render/index.js";
import { validateBpmnModel, type BpmnValidationResult } from "./validation/bpmnValidation.js";
import type { ParseResult } from "./dsl/ast.js";
import type BpmnModeler from "bpmn-js/lib/Modeler";

export { parseDsl } from "./dsl/index.js";
export { emitBpmnXml } from "./bpmn/emit.js";
export { renderSemanticXml, type RenderOptions, type RenderResult } from "./render/index.js";
export {
  validateBpmnModel,
  type BpmnValidationFinding,
  type BpmnValidationMetrics,
  type BpmnValidationOptions,
  type BpmnValidationOrigin,
  type BpmnValidationResult,
  type BpmnValidationSeverity,
  type BpmnValidationStatus,
} from "./validation/bpmnValidation.js";
export * from "./dsl/ast.js";

export type GenerateDiagramResult = {
  parse: ParseResult;
  xml: string;
  render: RenderResult;
  validation: BpmnValidationResult;
};

/**
 * Convenience helper that runs the full pipeline:
 *   parseDsl → emitBpmnXml → renderSemanticXml → validateBpmnModel
 *
 * Apps that need finer control (live editor with debounce, custom
 * validation handling, etc.) should call the individual functions
 * directly. `generateDiagram` is intended for simpler surfaces like
 * the company-web demo.
 */
export async function generateDiagram(
  input: string,
  opts: { modeler: BpmnModeler },
): Promise<GenerateDiagramResult> {
  const parse = parseDsl(input);
  const xml = emitBpmnXml(parse.model);
  const render = await renderSemanticXml(opts.modeler, xml, parse.model);
  const validation = validateBpmnModel(parse.model, { layoutXml: render.layoutXml });
  return { parse, xml, render, validation };
}
