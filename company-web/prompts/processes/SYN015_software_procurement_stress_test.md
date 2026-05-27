---
process_id: SYN015
process_source: synthetic
difficulty: stress
expected_features:
  - multiple_lanes
  - xor_gateway
  - parallel_gateway
  - message_flow
  - data_objects
  - timer_or_exception_event
---

# SYN015 - Software procurement stress test

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
A company wants to procure a new software tool. The requester submits a software request together with a business justification document and an estimated budget. The manager reviews the request. If the manager rejects it, the requester is informed and the process ends. If the manager approves it, the procurement team starts the sourcing process. Procurement sends a request for quotation to the supplier and waits for the supplier's quote. When the quote arrives, procurement reviews it and checks whether the quoted amount is within budget. If the quote is above budget, procurement asks the requester whether the scope should be reduced. If the requester declines to reduce scope, procurement informs the supplier that the opportunity is closed and the process ends. If the requester agrees to reduce scope, procurement requests a revised quote from the supplier and waits for the revised quote before continuing.

When the quote is acceptable, two reviews must happen in parallel: IT security reviews the supplier security questionnaire, and finance confirms budget availability. Add a note that the contract cannot be signed until both reviews are complete. If IT security finds a critical risk, procurement informs the requester that the request is rejected for security reasons and notifies the supplier. If finance cannot confirm budget availability within five business days, the request expires and procurement notifies the requester. If both reviews are completed successfully, procurement prepares the purchase recommendation, the manager gives final approval, procurement sends the purchase order to the supplier, the supplier sends an order confirmation, and procurement records the signed documents in the contract repository. The process ends after the requester is informed that the software purchase has been approved and ordered.
