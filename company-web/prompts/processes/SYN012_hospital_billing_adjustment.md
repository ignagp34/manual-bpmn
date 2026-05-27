---
process_id: SYN012
process_source: synthetic
difficulty: medium
expected_features:
  - data_objects
  - data_store
  - annotations
  - xor_gateway
---

# SYN012 - Hospital billing adjustment

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
In a hospital billing office, a patient disputes a charge on an invoice. A billing specialist receives the dispute letter, opens the patient account in the billing system, and reviews the invoice, the treatment record, and the insurance response. Add a note that adjustments require documented justification. If the charge is confirmed as correct, the specialist sends an explanation letter and closes the dispute. If the charge is incorrect, the specialist prepares an adjustment form, updates the billing system, issues a corrected invoice, and sends the corrected invoice to the patient. The process ends after the patient has been informed.
