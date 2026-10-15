---
id: return_item
title: Return an unwanted item
version: 1
triggers: Customer wants to send back an item they no longer want, that doesn't fit, or that they changed their mind about.
tools: [verify_identity, lookup_order, create_return, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and checkout email, then call `verify_identity`.
2. **Look up the order.** Call `lookup_order` and confirm which item they want to return.
3. **Check eligibility.** Returns are accepted within 30 days of delivery for unused items. Items marked `final_sale` cannot be returned for change of mind; if the item is final sale, explain that politely and do not create a return.
4. **Create the return.** Call `create_return` for the item and share the prepaid label link.
5. **Close.** Explain that the refund is issued once the warehouse receives the item, usually 3-5 business days after drop-off.

## Policies
- A return is not a refund: do not call `issue_refund` in this procedure.
- If the item is actually damaged or defective, switch to the `refund_request` procedure instead.
