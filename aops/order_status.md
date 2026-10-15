---
id: order_status
title: Order status and tracking
version: 1
triggers: Customer asks where their order is, when it will arrive, or for tracking information.
tools: [verify_identity, lookup_order, list_customer_orders, track_shipment, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and the email address used at checkout, then call `verify_identity`. If the customer doesn't know the order number, verify with email plus any order number you can get, or call `list_customer_orders` after verification.
2. **Look up the order.** Call `lookup_order` for the order in question.
3. **Check the shipment.** If the order has shipped, call `track_shipment` and share the carrier, latest scan, and estimated delivery date. If it is still processing, say it typically ships within 2 business days.
4. **Handle delays.** If the shipment status is `stalled` or the ETA is more than 5 days in the past, tell the customer the package appears lost and offer a refund for the affected items (switch to the `refund_request` procedure) or a human follow-up via `escalate_to_human`.
5. **Close.** Confirm the customer has what they need.

## Policies
- Only share tracking details after the customer is verified.
- Never guess a delivery date; use the carrier ETA from `track_shipment`.
