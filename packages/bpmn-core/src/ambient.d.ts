declare module "bpmn-auto-layout" {
  export function layoutProcess(xml: string): Promise<string>;
}

declare module "bpmn-moddle" {
  export default class BpmnModdle {
    constructor(options?: unknown);
    fromXML(xml: string): Promise<{ rootElement: unknown; warnings: unknown[] }>;
    toXML(element: unknown, opts?: { format?: boolean }): Promise<{ xml: string }>;
    create(type: string, props?: Record<string, unknown>): unknown;
  }
}
