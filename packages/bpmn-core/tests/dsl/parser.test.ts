import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDsl } from "../../src/dsl/index.js";

const fixturesDir = resolvePath(__dirname, "..", "fixtures");
function read(name: string): string {
  return readFileSync(resolvePath(fixturesDir, name), "utf8");
}

const validFixtures = [
  "gemini-03.dsl",
  "gemini-04.dsl",
  "gemini-05.dsl",
  "s17-order-to-ship.dsl",
  "s17-job-application.dsl",
  "s17-pizza-order.dsl",
  "s17-document-approval.dsl",
  "s-a3-find-a-job.dsl",
  "es-almacen.dsl",
];

describe("parser — valid fixtures", () => {
  for (const fx of validFixtures) {
    it(`parses ${fx} without error-severity diagnostics`, () => {
      const result = parseDsl(read(fx));
      const errors = result.errors.filter((e) => e.severity === "error");
      if (errors.length > 0) {
        console.error(`Errors in ${fx}:`, errors);
      }
      expect(errors).toEqual([]);
      expect(result.program.traces.length).toBeGreaterThan(0);
      expect(result.model.flowNodes.size).toBeGreaterThan(0);
    });
  }
});

describe("parser — element counts", () => {
  it("gemini-04 has 4 traces, a stock-level gateway, and 2 data-object types", () => {
    const r = parseDsl(read("gemini-04.dsl"));
    expect(r.program.traces.length).toBe(4);
    const gateways = [...r.model.flowNodes.values()].filter(
      (n) => n.kind === "exclusiveGateway" || n.kind === "eventBasedGateway",
    );
    expect(gateways.length).toBeGreaterThanOrEqual(1);
    const dataLabels = new Set<string>();
    for (const t of r.program.traces) {
      for (const s of t.steps) if (s.kind === "Data") dataLabels.add(s.label);
    }
    expect(dataLabels.has("Order List")).toBe(true);
    expect(dataLabels.has("Parts")).toBe(true);
  });

  it("gemini-05 has a (timer) start-side event and a (deadline 30 days) boundary event", () => {
    const r = parseDsl(read("gemini-05.dsl"));
    const allEventSubtypes = new Set<string>();
    for (const t of r.program.traces) {
      for (const s of t.steps) {
        if (s.kind === "Event") allEventSubtypes.add(s.eventType);
        if (s.kind === "Task") for (const b of s.boundary) allEventSubtypes.add(b.eventType);
      }
    }
    expect(allEventSubtypes.has("timer")).toBe(true);
    expect(allEventSubtypes.has("deadline")).toBe(true);
    const boundary = [...r.model.flowNodes.values()].find((n) => n.kind === "boundaryEvent");
    expect(boundary).toBeDefined();
    expect(boundary?.eventType).toBe("deadline");
  });

  it("s17-order-to-ship merges 'Place order' across the two traces into one node", () => {
    const r = parseDsl(read("s17-order-to-ship.dsl"));
    const placeOrders = [...r.model.flowNodes.values()].filter(
      (n) => n.kind === "task" && n.label === "Place order",
    );
    expect(placeOrders.length).toBe(1);
    // The merged node should have an outgoing flow.
    const id = placeOrders[0].id;
    const outgoing = r.model.flows.filter((f) => f.sourceId === id);
    expect(outgoing.length).toBeGreaterThan(0);
  });

  it("s17-job-application captures the parallel split as a parallelGateway node", () => {
    const r = parseDsl(read("s17-job-application.dsl"));
    const parallelGw = [...r.model.flowNodes.values()].find((n) => n.kind === "parallelGateway");
    expect(parallelGw).toBeDefined();
  });

  it("es-almacen recognises accented pool names as distinct participants/lanes", () => {
    const r = parseDsl(read("es-almacen.dsl"));
    const pools = new Set<string>();
    for (const node of r.model.flowNodes.values()) {
      if (node.pool) pools.add(node.pool);
    }
    expect(pools.has("Almacén")).toBe(true);
    expect(pools.has("Atención al cliente")).toBe(true);
    expect(pools.has("Mensajería")).toBe(true);
    expect(pools.has("Cliente")).toBe(true);
  });
});
