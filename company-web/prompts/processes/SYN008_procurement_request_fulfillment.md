---
process_id: SYN008
process_source: synthetic
difficulty: medium
expected_features:
  - parallel_gateway
  - fork_join
  - single_pool
  - tasks
---

# SYN008 - Procurement request fulfillment

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
In a procurement office, a department submits a request for standard office equipment. A procurement specialist reviews the request and confirms that the items are on the approved catalog. Then the specialist starts three activities in parallel: reserve budget, create the purchase order, and notify the warehouse of the expected delivery. Once all three activities are completed, the specialist sends the order confirmation to the requesting department and closes the request.
