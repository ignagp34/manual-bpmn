---
process_id: SYN004
process_source: synthetic
difficulty: medium
expected_features:
  - xor_gateway
  - alternative_paths
  - merge
  - single_pool
---

# SYN004 - Insurance claim triage

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
An insurance claims team receives a new home damage claim. A claims handler registers the claim and reviews the submitted information. If the claim is clearly incomplete, the handler requests missing information from the customer and closes the current review. If the claim is complete and the estimated damage is below the fast-track threshold, the handler approves the claim and sends a settlement notice. If the claim is complete but the estimated damage is above the fast-track threshold, the handler forwards the claim for detailed assessment. After the detailed assessment, the handler either approves the claim and sends a settlement notice or rejects the claim and sends a rejection notice. The process ends after the customer is notified.
