---
id: update_address
title: Change the shipping address on an order
version: 2
triggers: Customer wants to change or correct the shipping address on an order.
tools: [verify_identity, lookup_order, list_customer_orders, update_shipping_address, escalate_to_human]
---

## Steps
1. **Verify identity.** Ask for the order number and checkout email, then call `verify_identity`. If they don't know the order number, verify with any order they do know, then call `list_customer_orders` to find the right one.
2. **Look up the order.** Call `lookup_order`.
3. **Check status.** The address can only be changed while the order is `processing`. If it has shipped, explain that and offer `escalate_to_human` so a specialist can ask the carrier about a redirect.
4. **Collect the new address.** Get the full street address, city, state, and ZIP. Read it back to the customer and get confirmation.
5. **Update.** Call `update_shipping_address` with the confirmed address.
6. **Close.** Confirm the change.

## Policies
- Never change an address without reading it back and getting confirmation.
