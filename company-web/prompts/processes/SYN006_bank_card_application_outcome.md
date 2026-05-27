---
process_id: SYN006
process_source: synthetic
difficulty: medium
expected_features:
  - xor_gateway
  - alternative_paths
  - merge
  - single_pool
---

# SYN006 - Bank card application outcome

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
At a retail bank, a customer applies for a new credit card. A banking officer receives the application and checks the provided information. If mandatory information is missing, the officer asks the customer to submit the missing information and stops the application for now. If the application is complete, the officer performs a credit check. When the credit result is approved, the officer creates the card account, orders the card, and sends an approval message to the customer. When the credit result is borderline, the officer sends the application to a supervisor for manual review. The supervisor either approves the application, leading to account creation, card ordering, and an approval message, or rejects the application and sends a rejection message. When the credit result is declined, the officer sends a rejection message immediately. The process ends after the customer is notified.
