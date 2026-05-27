import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDsl } from "../../src/dsl/index.js";

const fixturesDir = resolvePath(__dirname, "..", "fixtures");
const read = (name: string) => readFileSync(resolvePath(fixturesDir, name), "utf8");

describe("anchor-boundary violations", () => {
  it("AP-6: regular trace ends at a fragment leading-anchor without trailing '...'", () => {
    const r = parseDsl(read("_invalid/ap6-trace-ends-at-anchor.dsl"));
    const ap6 = r.errors.filter((e) => e.code === "AP-6");
    expect(ap6.length).toBeGreaterThanOrEqual(1);
    expect(ap6[0].severity).toBe("error");
    expect(ap6[0].message).toMatch(/Decide on hiring/);
  });

  it("AP-7: anchor task buried in fragment interior", () => {
    const r = parseDsl(read("_invalid/ap7-anchor-buried.dsl"));
    const ap7 = r.errors.filter((e) => e.code === "AP-7");
    expect(ap7.length).toBeGreaterThanOrEqual(1);
    expect(ap7[0].severity).toBe("error");
  });

  it("Errors do not abort: a model is still produced for AP-6 input", () => {
    const r = parseDsl(read("_invalid/ap6-trace-ends-at-anchor.dsl"));
    expect(r.model.flowNodes.size).toBeGreaterThan(0);
  });
});

describe("code-fence stripping", () => {
  it("wrapping a valid fixture in ``` produces an identical AST shape", () => {
    const raw = read("s17-order-to-ship.dsl");
    const fenced = "```\n" + raw + "```\n";
    const a = parseDsl(raw);
    const b = parseDsl(fenced);
    expect(b.program.traces.length).toBe(a.program.traces.length);
    expect(b.model.flowNodes.size).toBe(a.model.flowNodes.size);
  });

  it("gemini-05 parses through its actual leading/trailing ``` fences", () => {
    const r = parseDsl(read("gemini-05.dsl"));
    const errors = r.errors.filter((e) => e.severity === "error");
    expect(errors).toEqual([]);
  });
});

describe("inline '//' annotation tolerance", () => {
  it("strips inline '// note' from a task line and emits an INLINE-COMMENT warning", () => {
    const src = "Customer: Place order // urgent\nShop: Confirm\n";
    const r = parseDsl(src);
    const warn = r.errors.find((e) => e.code === "INLINE-COMMENT");
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warning");
    const placeOrder = [...r.model.flowNodes.values()].find((n) => n.label === "Place order");
    expect(placeOrder).toBeDefined();
    expect(placeOrder?.annotations).toContain("urgent");
  });
});

describe("pool first-mention persistence", () => {
  it("a task first seen with an explicit pool keeps that pool when re-mentioned without prefix", () => {
    const src = `Customer: Place order
Shop: Acknowledge

Place order
Shop: Process
`;
    const r = parseDsl(src);
    const placeOrders = [...r.model.flowNodes.values()].filter((n) => n.label === "Place order");
    expect(placeOrders.length).toBe(1);
    expect(placeOrders[0].pool).toBe("Customer");
  });

  it("canon-2 does not register a synthetic Pool_1 for the unlabeled opening start event", () => {
    const r = parseDsl(read("canon-2-incoming-flight.dsl"));
    expect(r.program.pools.map((p) => p.name)).not.toContain("Pool_1");
  });
});

describe("annotation attachment", () => {
  it("a leading '//' annotation attaches to the next task", () => {
    const src = `Customer:
//Includes near misses
Place order
`;
    const r = parseDsl(src);
    const placeOrder = [...r.model.flowNodes.values()].find((n) => n.label === "Place order");
    expect(placeOrder?.annotations).toContain("Includes near misses");
  });
});

describe("parallel rows", () => {
  it("a parallel row creates a parallelGateway node and lane tasks", () => {
    const src = `HR: Inspect Dossier|Check References
Decide
`;
    const r = parseDsl(src);
    const parallel = [...r.model.flowNodes.values()].find((n) => n.kind === "parallelGateway");
    expect(parallel).toBeDefined();
    const inspect = [...r.model.flowNodes.values()].find((n) => n.label === "Inspect Dossier");
    const refs = [...r.model.flowNodes.values()].find((n) => n.label === "Check References");
    expect(inspect).toBeDefined();
    expect(refs).toBeDefined();
  });
});

describe("data object identity", () => {
  it("canon-5 reuses repeated opening data objects across both traces", () => {
    const r = parseDsl(read("canon-5-marriage.dsl"));
    const labels = [...r.model.flowNodes.values()]
      .filter((n) => n.kind === "dataObject" || n.kind === "dataStore")
      .map((n) => n.label);

    expect(labels.filter((label) => label === "Unapostilled Documents")).toHaveLength(1);
    expect(labels.filter((label) => label === "Apostilled Documents")).toHaveLength(1);
    expect(labels.filter((label) => label === "Spanish Documents")).toHaveLength(1);
  });

  it("deduplicates repeated leading data inputs before Pool_1 fallback is inferred", () => {
    const r = parseDsl(read("s17-document-approval.dsl"));
    const draftDocs = [...r.model.flowNodes.values()].filter(
      (n) => n.kind === "dataObject" && n.label === "Draft Document",
    );

    expect(draftDocs).toHaveLength(1);
    expect(draftDocs[0].attachedInputOf).toBeDefined();
  });
});
