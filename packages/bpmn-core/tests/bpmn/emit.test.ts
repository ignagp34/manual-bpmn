import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, it, expect } from "vitest";
import BpmnModdle from "bpmn-moddle";
import { parseDsl } from "../../src/dsl/index.js";
import { emitBpmnXml } from "../../src/bpmn/emit.js";

const fixturesDir = resolvePath(__dirname, "..", "fixtures");
const read = (name: string) => readFileSync(resolvePath(fixturesDir, name), "utf8");

const validFixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".dsl"))
  .sort();

function countMatches(xml: string, tag: string): number {
  const re = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s>/]`, "g");
  const m = xml.match(re);
  return m ? m.length : 0;
}

async function importViaModdle(xml: string): Promise<void> {
  const moddle = new BpmnModdle();
  // bpmn-moddle's fromXML is async; throws on schema/parse error.
  await moddle.fromXML(xml);
}

describe("emitBpmnXml — round-trip per fixture", () => {
  for (const name of validFixtures) {
    it(`${name} emits XML that bpmn-moddle imports cleanly`, async () => {
      const result = parseDsl(read(name));
      const xml = emitBpmnXml(result.model);
      expect(xml).toMatch(/^<\?xml version="1\.0"/);
      expect(xml).toContain("<bpmn:definitions");
      expect(xml).toContain("</bpmn:definitions>");
      await expect(importViaModdle(xml)).resolves.toBeUndefined();
    });

    it(`${name}: element counts align with the resolved model`, () => {
      const result = parseDsl(read(name));
      const xml = emitBpmnXml(result.model);
      const flow = Array.from(result.model.flowNodes.values());
      const taskCount = flow.filter((n) => n.kind === "task").length;
      const startCount = flow.filter((n) => n.kind === "startEvent").length;
      const endCount = flow.filter((n) => n.kind === "endEvent").length;
      const xorCount = flow.filter((n) => n.kind === "exclusiveGateway").length;
      const parGwCount = flow.filter((n) => n.kind === "parallelGateway").length;
      const evGwCount = flow.filter((n) => n.kind === "eventBasedGateway").length;
      const boundaryCount = flow.filter((n) => n.kind === "boundaryEvent").length;
      // M3 added typed tasks (user/service/manual/rule/receive/send/script).
      // Sum the plain task tag plus every typed task tag against AST task count.
      const allTaskTags =
        countMatches(xml, "bpmn:task") +
        countMatches(xml, "bpmn:userTask") +
        countMatches(xml, "bpmn:serviceTask") +
        countMatches(xml, "bpmn:manualTask") +
        countMatches(xml, "bpmn:businessRuleTask") +
        countMatches(xml, "bpmn:receiveTask") +
        countMatches(xml, "bpmn:sendTask") +
        countMatches(xml, "bpmn:scriptTask");
      expect(allTaskTags).toBe(taskCount);
      expect(countMatches(xml, "bpmn:startEvent")).toBe(startCount);
      expect(countMatches(xml, "bpmn:endEvent")).toBe(endCount);
      expect(countMatches(xml, "bpmn:exclusiveGateway")).toBe(xorCount);
      expect(countMatches(xml, "bpmn:parallelGateway")).toBe(parGwCount);
      expect(countMatches(xml, "bpmn:eventBasedGateway")).toBe(evGwCount);
      expect(countMatches(xml, "bpmn:boundaryEvent")).toBe(boundaryCount);
      expect(countMatches(xml, "bpmn:sequenceFlow")).toBe(result.model.flows.length);
      expect(countMatches(xml, "bpmn:messageFlow")).toBe(result.model.messageFlows.length);
    });
  }
});

describe("emitBpmnXml - canon-2 pool fallback", () => {
  it("does not emit a Pool_1 participant or lane for the opening start event", () => {
    const result = parseDsl(read("canon-2-incoming-flight.dsl"));
    const xml = emitBpmnXml(result.model);

    expect(xml).not.toMatch(/<bpmn:participant[^>]*name="Pool_1"/);
    expect(xml).not.toMatch(/<bpmn:lane[^>]*name="Pool_1"/);
    expect(xml).toMatch(/<bpmn:lane[^>]*name="Pilot"/);
  });
});

describe("emitBpmnXml — participant grouping (gemini-03)", () => {
  it("merges Employee+Employer and Student+Directorate into shared participants", () => {
    const result = parseDsl(read("gemini-03.dsl"));
    const xml = emitBpmnXml(result.model);
    // 4 participants: {Employee, Employer}, {Self-Employed}, {Student, Directorate}, {Insured Party}
    expect(countMatches(xml, "bpmn:participant")).toBe(4);
    // 6 lanes total (one per declared pool)
    expect(countMatches(xml, "bpmn:lane")).toBeGreaterThanOrEqual(6);
    // Both shared participants must contain a lane named after each member.
    expect(xml).toMatch(/<bpmn:lane[^>]*name="Employee"/);
    expect(xml).toMatch(/<bpmn:lane[^>]*name="Employer"/);
    expect(xml).toMatch(/<bpmn:lane[^>]*name="Student"/);
    expect(xml).toMatch(/<bpmn:lane[^>]*name="Directorate"/);
  });
});

describe("emitBpmnXml — boundary events (gemini-05)", () => {
  it("emits cancelActivity for interrupting boundary events", () => {
    const result = parseDsl(read("gemini-05.dsl"));
    const xml = emitBpmnXml(result.model);
    const boundaries = Array.from(result.model.flowNodes.values()).filter(
      (n) => n.kind === "boundaryEvent",
    );
    if (boundaries.length === 0) return;
    expect(xml).toMatch(/<bpmn:boundaryEvent[^>]*attachedToRef=/);
    expect(xml).toMatch(/cancelActivity="(true|false)"/);
  });
});

describe("emitBpmnXml — annotations and data refs", () => {
  it("synthesizes textAnnotation + association for each FlowNode annotation", () => {
    const result = parseDsl(read("gemini-03.dsl"));
    const xml = emitBpmnXml(result.model);
    const annotationCount = Array.from(result.model.flowNodes.values()).reduce(
      (acc, n) => acc + n.annotations.length,
      0,
    );
    if (annotationCount > 0) {
      expect(countMatches(xml, "bpmn:textAnnotation")).toBeGreaterThanOrEqual(annotationCount);
      expect(countMatches(xml, "bpmn:association")).toBeGreaterThanOrEqual(annotationCount);
    }
  });
});
