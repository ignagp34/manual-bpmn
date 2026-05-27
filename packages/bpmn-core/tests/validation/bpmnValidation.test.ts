// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { FlowNode, ResolvedModel, SequenceFlow } from "../../src/dsl/ast.js";
import { validateBpmnModel } from "../../src/validation/bpmnValidation.js";

function node(id: string, kind: FlowNode["kind"], label: string, pool = "Pool_1"): FlowNode {
  return {
    annotations: [],
    id,
    kind,
    label,
    pool,
    sourceLine: 1,
  };
}

function flow(id: string, sourceId: string, targetId: string): SequenceFlow {
  return { id, sourceId, targetId };
}

function model(nodes: FlowNode[], flows: SequenceFlow[]): ResolvedModel {
  return {
    errors: [],
    flowNodes: new Map(nodes.map((item) => [item.id, item])),
    flows,
    messageFlows: [],
    pools: [{ name: "Pool_1", nodeIds: nodes.map((item) => item.id) }],
  };
}

function codes(result: ReturnType<typeof validateBpmnModel>): string[] {
  return [...result.errors, ...result.warnings, ...result.info].map((finding) => finding.code);
}

describe("BPMN validation", () => {
  it("passes a clean start-task-end model", () => {
    const result = validateBpmnModel(
      model(
        [node("Start_1", "startEvent", "Start"), node("Task_1", "task", "Do work"), node("End_1", "endEvent", "End")],
        [flow("Flow_1", "Start_1", "Task_1"), flow("Flow_2", "Task_1", "End_1")],
      ),
    );

    expect(result.status).toBe("passed");
    expect(result.errors).toEqual([]);
    expect(result.metrics.numActivities).toBe(1);
  });

  it("detects activities without incoming and outgoing flows", () => {
    const result = validateBpmnModel(model([node("Task_1", "task", "Do work")], []));

    expect(codes(result)).toEqual(expect.arrayContaining(["ISOLATED_NODE"]));
    expect(result.status).toBe("failed");
  });

  it("detects a task missing only outgoing flow", () => {
    const result = validateBpmnModel(
      model(
        [node("Start_1", "startEvent", "Start"), node("Task_1", "task", "Do work")],
        [flow("Flow_1", "Start_1", "Task_1")],
      ),
    );

    expect(codes(result)).toEqual(expect.arrayContaining(["ACTIVITY_WITHOUT_OUTGOING", "DEAD_END_NODE"]));
    expect(result.metrics.deadEndNodes).toBe(1);
  });

  it("warns when explicit start or end events are missing", () => {
    const result = validateBpmnModel(
      model(
        [node("StartEvent_implicit_Task_1", "startEvent", ""), node("Task_1", "task", "Do work")],
        [flow("Flow_1", "StartEvent_implicit_Task_1", "Task_1")],
      ),
    );

    expect(codes(result)).toEqual(
      expect.arrayContaining(["MISSING_EXPLICIT_START_EVENT", "IMPLICIT_START_EVENT", "MISSING_EXPLICIT_END_EVENT"]),
    );
  });

  it("detects start events with incoming flows and end events with outgoing flows", () => {
    const result = validateBpmnModel(
      model(
        [node("Start_1", "startEvent", "Start"), node("End_1", "endEvent", "End")],
        [flow("Flow_1", "End_1", "Start_1")],
      ),
    );

    expect(codes(result)).toEqual(expect.arrayContaining(["START_EVENT_WITH_INCOMING", "END_EVENT_WITH_OUTGOING"]));
  });

  it("detects gateways without required flow and suspicious pass-through structure", () => {
    const result = validateBpmnModel(
      model(
        [
          node("Start_1", "startEvent", "Start"),
          node("Gateway_1", "exclusiveGateway", "Decision"),
          node("End_1", "endEvent", "End"),
          node("Gateway_2", "parallelGateway", "Unused"),
        ],
        [flow("Flow_1", "Start_1", "Gateway_1"), flow("Flow_2", "Gateway_1", "End_1")],
      ),
    );

    expect(codes(result)).toEqual(
      expect.arrayContaining([
        "GATEWAY_SUSPICIOUS_PASSTHROUGH",
        "ISOLATED_NODE",
      ]),
    );
  });

  it("does not warn for valid split or join gateway degrees", () => {
    const result = validateBpmnModel(
      model(
        [
          node("Start_1", "startEvent", "Start"),
          node("Split_1", "exclusiveGateway", "Split"),
          node("Task_A", "task", "A"),
          node("Task_B", "task", "B"),
          node("Join_1", "exclusiveGateway", "Join"),
          node("End_1", "endEvent", "End"),
        ],
        [
          flow("Flow_1", "Start_1", "Split_1"),
          flow("Flow_2", "Split_1", "Task_A"),
          flow("Flow_3", "Split_1", "Task_B"),
          flow("Flow_4", "Task_A", "Join_1"),
          flow("Flow_5", "Task_B", "Join_1"),
          flow("Flow_6", "Join_1", "End_1"),
        ],
      ),
    );

    expect(codes(result)).not.toContain("GATEWAY_SUSPICIOUS_PASSTHROUGH");
  });

  it("detects branches that do not eventually reach an end event", () => {
    const result = validateBpmnModel(
      model(
        [node("Start_1", "startEvent", "Start"), node("Task_1", "task", "Loop"), node("End_1", "endEvent", "End")],
        [flow("Flow_1", "Start_1", "Task_1"), flow("Flow_2", "Task_1", "Task_1")],
      ),
    );

    expect(codes(result)).toEqual(expect.arrayContaining(["BRANCH_WITHOUT_END_REACHABILITY"]));
  });

  it("detects invalid message flows", () => {
    const source = node("Task_1", "task", "Send", "Pool_1");
    const target = node("Task_2", "task", "Receive", "Pool_1");
    const sample = model([source, target], []);
    sample.messageFlows = [{ id: "MessageFlow_1", sourceId: source.id, targetId: target.id, label: "Notice" }];

    const result = validateBpmnModel(sample);

    expect(codes(result)).toEqual(expect.arrayContaining(["MESSAGE_FLOW_WITHIN_POOL", "MESSAGE_FLOW_INVALID_ENDPOINT"]));
  });

  it("warns for duplicated data objects and comments", () => {
    const firstData = node("Data_1", "dataObject", "Document");
    const secondData = node("Data_2", "dataObject", "Document");
    const task = { ...node("Task_1", "task", "Check"), annotations: ["note", "note"] };

    const result = validateBpmnModel(model([firstData, secondData, task], []));

    expect(codes(result)).toEqual(expect.arrayContaining(["DUPLICATED_DATA_OBJECT", "DUPLICATED_COMMENT"]));
  });

  it("warns for layout overlaps, unreadable labels, and far artifacts", () => {
    const layoutXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC">
  <bpmn:process id="Process_1">
    <bpmn:startEvent id="Start_1" name="Start" />
    <bpmn:task id="Task_1" name="This label is much too long for this narrow task" />
    <bpmn:task id="Task_2" name="Overlap" />
    <bpmn:textAnnotation id="Text_1"><bpmn:text>Comment</bpmn:text></bpmn:textAnnotation>
    <bpmn:association id="Association_1" sourceRef="Task_1" targetRef="Text_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Shape_Task_1" bpmnElement="Task_1"><dc:Bounds x="100" y="100" width="80" height="60" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Shape_Task_2" bpmnElement="Task_2"><dc:Bounds x="120" y="120" width="80" height="60" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Shape_Text_1" bpmnElement="Text_1"><dc:Bounds x="800" y="100" width="100" height="80" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const result = validateBpmnModel(
      model(
        [node("Start_1", "startEvent", "Start"), node("Task_1", "task", "Do work"), node("End_1", "endEvent", "End")],
        [flow("Flow_1", "Start_1", "Task_1"), flow("Flow_2", "Task_1", "End_1")],
      ),
      { layoutXml },
    );

    expect(codes(result)).toEqual(
      expect.arrayContaining(["LAYOUT_ELEMENT_OVERLAP", "LAYOUT_UNREADABLE_LABEL", "LAYOUT_ARTIFACT_TOO_FAR"]),
    );
  });
});
