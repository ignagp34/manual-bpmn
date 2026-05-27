import { parse } from "./parser.js";
import { resolve } from "./semantic.js";
import type { DslError, ParseResult } from "./ast.js";

export function parseDsl(source: string): ParseResult {
  const program = parse(source);
  const model = resolve(program);
  const errors: DslError[] = sortAndDedupeErrors([...program.errors, ...model.errors]);
  return { program, model, errors };
}

function sortAndDedupeErrors(errs: DslError[]): DslError[] {
  const sorted = [...errs].sort((a, b) => a.line - b.line);
  const seen = new Set<string>();
  const out: DslError[] = [];
  for (const e of sorted) {
    const key = `${e.code}::${e.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export type { DslError, ParseResult } from "./ast.js";
export * from "./ast.js";
export { emitBpmnXml } from "../bpmn/emit.js";
