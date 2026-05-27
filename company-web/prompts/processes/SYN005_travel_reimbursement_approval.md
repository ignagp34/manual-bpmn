---
process_id: SYN005
process_source: synthetic
difficulty: medium
expected_features:
  - xor_gateway
  - alternative_paths
  - merge
  - single_pool
---

# SYN005 - Travel reimbursement approval

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
In a finance department, an employee submits a travel reimbursement request. A finance specialist checks the receipts and verifies the policy rules. If receipts are missing, the specialist returns the request to the employee and ends the review. If the request is valid and the total amount is within the automatic approval limit, the specialist approves it and schedules payment. If the request is valid but exceeds the automatic approval limit, the specialist sends it to the finance manager. The finance manager either approves the request, after which payment is scheduled, or rejects it, after which a rejection message is sent to the employee. The process ends when the employee has been informed of the outcome.
