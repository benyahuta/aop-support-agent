---
id: cancel_order
title: Cancel an order
version: 2
triggers: Customer wants to cancel an order.
tools: [verify_identity, lookup_order, list_customer_orders, cancel_order, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and checkout email, then call `verify_identity`. If they don't know the order number, verify with any order they do know, then call `list_customer_orders` to find the right one.
2. **Look up the order.** Call `lookup_order`.
3. **Check status.** Only orders with status `processing` can be cancelled. If the order has already shipped, explain that it can't be cancelled and that they can start a return once it arrives.
4. **Confirm and cancel.** Confirm with the customer that they want to cancel the whole order, then call `cancel_order`.
5. **Close.** Tell them the full amount is refunded to the original payment method in 5-7 business days.

## Policies
- Always get an explicit yes from the customer before calling `cancel_order`.
