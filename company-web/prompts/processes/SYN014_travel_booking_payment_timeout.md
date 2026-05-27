---
process_id: SYN014
process_source: synthetic
difficulty: hard
expected_features:
  - timer_event
  - cancellation
  - exception_flow
  - multiple_pools
---

# SYN014 - Travel booking payment timeout

Use the BPMN Sketch Miner DSL to model the following process.
Return only the DSL output. Do not include explanations, markdown fences, or comments outside the DSL.

Process description:
A traveler books a train ticket through an online travel agency. The agency sends a payment request to the traveler after the reservation is created. The traveler can pay the booking before the payment deadline, in which case the agency receives the payment, issues the ticket, and sends the ticket to the traveler. If the payment deadline expires before payment is received, the reservation is cancelled automatically and the agency sends a cancellation notice to the traveler. The process ends when the traveler receives either the ticket or the cancellation notice.
