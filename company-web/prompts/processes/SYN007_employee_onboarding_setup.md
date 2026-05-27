---
process_id: SYN007
process_source: synthetic
difficulty: medium
expected_features:
  - parallel_gateway
  - fork_join
  - single_pool
  - tasks
---

# SYN007 - Employee onboarding setup

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
An HR operations team prepares onboarding for a new employee. The team receives the signed contract and records the start date. Then three activities can happen in parallel: create the employee profile in the HR system, prepare the laptop, and assign mandatory training. After all three are finished, the onboarding coordinator sends the welcome package to the employee and marks the onboarding setup as complete.
