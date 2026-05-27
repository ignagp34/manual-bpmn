import BpmnModdle from "bpmn-moddle";

/**
 * Defuse the gemini-05 crash inside bpmn-auto-layout 0.5.0.
 *
 * `lib/handler/attachersHandler.js:15` reads `att.outgoing.reverse()` on every
 * boundary event attached to a task. When a boundary event has no outgoing
 * sequence flow (an interrupting boundary that ends the trace, e.g. canon-5's
 * `(error Wedding Rejected)` end-event boundary in some shapes, or gemini-05's
 * `(deadline 30 days)` ending the registration trace), bpmn-moddle leaves
 * `outgoing` undefined and the call throws `Cannot read properties of
 * undefined (reading 'reverse')`.
 *
 * Fix: parse the semantic XML through bpmn-moddle, default every
 * boundaryEvent's `outgoing` to `[]`, then re-serialize. Round-trips through
 * moddle preserve everything we emit (the emitter is moddle-compatible, see
 * the round-trip tests in tests/bpmn/emit.test.ts).
 */
export async function sanitizeForLayout(xml: string): Promise<string> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const defs = rootElement as { rootElements?: Array<{ $type: string; flowElements?: unknown[] }> };
  for (const root of defs.rootElements ?? []) {
    if (root.$type !== "bpmn:Process") continue;
    walkFlowElements(root.flowElements ?? []);
  }
  const { xml: out } = await moddle.toXML(rootElement, { format: false });
  return out;
}

type FlowEl = {
  $type: string;
  outgoing?: unknown[];
  flowElements?: FlowEl[];
};

function walkFlowElements(elements: unknown[]): void {
  for (const elRaw of elements) {
    const el = elRaw as FlowEl;
    if (el.$type === "bpmn:BoundaryEvent" && !Array.isArray(el.outgoing)) {
      el.outgoing = [];
    }
    if (Array.isArray(el.flowElements)) {
      walkFlowElements(el.flowElements);
    }
  }
}
