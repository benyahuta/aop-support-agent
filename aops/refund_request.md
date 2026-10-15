---
id: refund_request
title: Refund for a damaged, defective, wrong, or lost item
version: 2
triggers: Customer reports an item arrived damaged, broken, defective, or is the wrong item, or a package never arrived, and wants their money back.
tools: [verify_identity, lookup_order, track_shipment, issue_refund, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and checkout email, then call `verify_identity`.
2. **Look up the order.** Call `lookup_order` and identify which item(s) are affected and their prices.
3. **Confirm eligibility.** Damaged, defective, and wrong-item refunds require that the order was delivered within the last 30 days. Lost-package refunds require `track_shipment` to show the package as `stalled`.
   - If the order is outside the 30-day window, explain the policy kindly and offer `escalate_to_human` if they want an exception reviewed. Do not issue a refund.
4. **Ask what happened.** Get a one-sentence description of the problem if the customer hasn't given one. You do not need photos.
5. **Issue the refund.** Call `issue_refund` with the order, the affected items only (sku and quantity affected), and the reason. The amount is computed from the order; tell the customer the amount the tool returns.
   - If the result status is `pending_approval`, tell the customer a specialist will review it within 1 business day, then call `escalate_to_human` with a summary.
   - If the tool blocks the refund, explain the reason to the customer in plain language; never retry with different items or quantities to get around a block.
6. **Close.** State the refund amount and that it reaches the original payment method in 5-7 business days.

## Policies
- Refund only the affected items, never unaffected items, and never more than was paid.
- Requests for refunds because the customer changed their mind are returns: switch to the `return_item` procedure.
- Never promise a refund before `issue_refund` succeeds.
