// A "World" is one isolated copy of the Larkspur & Pine backend: customers,
// orders, shipments, refunds, returns, tickets. Every chat session and every
// eval run gets its own in-memory SQLite world, seeded identically, so runs are
// reproducible and the public demo can't be polluted by other visitors.
import { DatabaseSync } from "node:sqlite";
import { SEED, STORE_CLOCK } from "./seed.ts";

export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  zip: string;
  tier: "standard" | "gold";
}

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unit_price: number;
  final_sale: number; // sqlite boolean
}

export interface Order {
  id: string;
  customer_id: string;
  status: OrderStatus;
  placed_at: string;
  delivered_at: string | null;
  total: number;
  refunded_amount: number;
  shipping_address: string;
  gift_message: string | null;
}

export interface Shipment {
  order_id: string;
  carrier: string;
  tracking: string;
  status: "label_created" | "in_transit" | "delivered" | "stalled";
  eta: string;
  last_event: string;
  last_event_at: string;
}

export interface Refund {
  id: string;
  order_id: string;
  amount: number;
  reason: string;
  status: "issued" | "pending_approval" | "denied";
  created_at: string;
  decided_by: string | null;
}

export interface ReturnRecord {
  id: string;
  order_id: string;
  sku: string;
  reason: string;
  label_url: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  customer_id: string | null;
  reason: string;
  summary: string;
  priority: "normal" | "urgent";
  created_at: string;
}

const SCHEMA = `
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, phone TEXT, zip TEXT, tier TEXT);
CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), status TEXT,
  placed_at TEXT, delivered_at TEXT, total REAL, refunded_amount REAL DEFAULT 0, shipping_address TEXT, gift_message TEXT);
CREATE TABLE order_items (order_id TEXT REFERENCES orders(id), sku TEXT, name TEXT, qty INTEGER, unit_price REAL, final_sale INTEGER);
CREATE TABLE shipments (order_id TEXT PRIMARY KEY REFERENCES orders(id), carrier TEXT, tracking TEXT, status TEXT,
  eta TEXT, last_event TEXT, last_event_at TEXT);
CREATE TABLE refunds (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), amount REAL, reason TEXT, status TEXT,
  created_at TEXT, decided_by TEXT);
CREATE TABLE refund_items (refund_id TEXT REFERENCES refunds(id), order_id TEXT, sku TEXT, qty INTEGER);
CREATE TABLE returns (id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(id), sku TEXT, reason TEXT, label_url TEXT, created_at TEXT);
CREATE TABLE tickets (id TEXT PRIMARY KEY, customer_id TEXT, reason TEXT, summary TEXT, priority TEXT, created_at TEXT);
`;

export class World {
  readonly db: DatabaseSync;
  /** One counter per id prefix: RF-0001, TCK-0001, RMA-0001. */
  private seq = new Map<string, number>();

  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(SCHEMA);
    this.seed();
  }

  /** The store's clock. Fixed so refund-window math is identical across runs. */
  now(): Date {
    return new Date(STORE_CLOCK);
  }

  private seed() {
    const c = this.db.prepare("INSERT INTO customers VALUES (?,?,?,?,?,?)");
    for (const x of SEED.customers) c.run(x.id, x.name, x.email, x.phone, x.zip, x.tier);
    const o = this.db.prepare("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)");
    const i = this.db.prepare("INSERT INTO order_items VALUES (?,?,?,?,?,?)");
    const s = this.db.prepare("INSERT INTO shipments VALUES (?,?,?,?,?,?,?)");
    for (const x of SEED.orders) {
      const total = x.items.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
      o.run(x.id, x.customer_id, x.status, x.placed_at, x.delivered_at ?? null, round(total), 0, x.shipping_address, x.gift_message ?? null);
      for (const it of x.items) i.run(x.id, it.sku, it.name, it.qty, it.unit_price, it.final_sale ? 1 : 0);
      if (x.shipment) {
        const sh = x.shipment;
        s.run(x.id, sh.carrier, sh.tracking, sh.status, sh.eta, sh.last_event, sh.last_event_at);
      }
      if (x.prior_refund) {
        // Seeded history: every item on the order was already refunded.
        const id = `RF-${x.id}-0`;
        this.db.prepare("INSERT INTO refunds VALUES (?,?,?,?,?,?,?)").run(id, x.id, x.prior_refund, "damaged", "issued", "2026-10-04T10:00:00.000Z", "seed");
        for (const it of x.items) this.db.prepare("INSERT INTO refund_items VALUES (?,?,?,?)").run(id, x.id, it.sku, it.qty);
        this.db.prepare("UPDATE orders SET refunded_amount = ? WHERE id = ?").run(x.prior_refund, x.id);
      }
    }
  }

  nextId(prefix: string): string {
    const n = (this.seq.get(prefix) ?? 0) + 1;
    this.seq.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  // --- reads ---------------------------------------------------------------
  customerByEmail(email: string): Customer | undefined {
    return this.db.prepare("SELECT * FROM customers WHERE lower(email) = lower(?)").get(email.trim()) as Customer | undefined;
  }
  customer(id: string): Customer | undefined {
    return this.db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as Customer | undefined;
  }
  order(id: string): Order | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE upper(id) = upper(?)").get(normalizeOrderId(id)) as Order | undefined;
  }
  items(orderId: string): OrderItem[] {
    return this.db.prepare("SELECT sku, name, qty, unit_price, final_sale FROM order_items WHERE order_id = ?").all(orderId) as unknown as OrderItem[];
  }
  shipment(orderId: string): Shipment | undefined {
    return this.db.prepare("SELECT * FROM shipments WHERE order_id = ?").get(orderId) as Shipment | undefined;
  }
  ordersFor(customerId: string): Order[] {
    return this.db.prepare("SELECT * FROM orders WHERE customer_id = ? ORDER BY placed_at DESC").all(customerId) as unknown as Order[];
  }
  orders(): Order[] {
    return this.db.prepare("SELECT * FROM orders ORDER BY id").all() as unknown as Order[];
  }
  refunds(orderId?: string): Refund[] {
    return (orderId
      ? this.db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY id").all(orderId)
      : this.db.prepare("SELECT * FROM refunds ORDER BY id").all()) as unknown as Refund[];
  }
  refund(id: string): Refund | undefined {
    return this.db.prepare("SELECT * FROM refunds WHERE id = ?").get(id) as Refund | undefined;
  }
  returns(): ReturnRecord[] {
    return this.db.prepare("SELECT * FROM returns ORDER BY id").all() as unknown as ReturnRecord[];
  }
  tickets(): Ticket[] {
    return this.db.prepare("SELECT * FROM tickets ORDER BY id").all() as unknown as Ticket[];
  }

  // --- writes --------------------------------------------------------------
  /** Quantity of a SKU already refunded or awaiting refund approval. */
  refundedQty(orderId: string, sku: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(ri.qty), 0) AS n FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
      WHERE ri.order_id = ? AND ri.sku = ? AND r.status IN ('issued', 'pending_approval')`).get(orderId, sku) as { n: number };
    return row.n;
  }

  /** Refund specific items. The amount is always computed from the order's prices, never taken from the model. */
  createRefund(orderId: string, lines: Array<{ sku: string; qty: number }>, reason: string, status: Refund["status"]): Refund {
    const items = this.items(orderId);
    const amount = round(lines.reduce((sum, l) => sum + l.qty * items.find((i) => i.sku === l.sku)!.unit_price, 0));
    const r: Refund = { id: this.nextId("RF"), order_id: orderId, amount, reason, status, created_at: this.now().toISOString(), decided_by: status === "issued" ? "agent" : null };
    this.db.prepare("INSERT INTO refunds VALUES (?,?,?,?,?,?,?)").run(r.id, r.order_id, r.amount, r.reason, r.status, r.created_at, r.decided_by);
    for (const l of lines) this.db.prepare("INSERT INTO refund_items VALUES (?,?,?,?)").run(r.id, orderId, l.sku, l.qty);
    if (status === "issued") this.addRefunded(orderId, r.amount);
    return r;
  }
  decideRefund(id: string, approve: boolean, by: string): Refund | undefined {
    const r = this.refund(id);
    if (!r || r.status !== "pending_approval") return undefined;
    const status = approve ? "issued" : "denied";
    this.db.prepare("UPDATE refunds SET status = ?, decided_by = ? WHERE id = ?").run(status, by, id);
    if (approve) this.addRefunded(r.order_id, r.amount);
    return this.refund(id);
  }
  private addRefunded(orderId: string, amount: number) {
    this.db.prepare("UPDATE orders SET refunded_amount = round(refunded_amount + ?, 2) WHERE id = ?").run(amount, orderId);
  }
  setOrderStatus(orderId: string, status: OrderStatus) {
    this.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
  }
  setAddress(orderId: string, address: string) {
    this.db.prepare("UPDATE orders SET shipping_address = ? WHERE id = ?").run(address, orderId);
  }
  createReturn(orderId: string, sku: string, reason: string): ReturnRecord {
    const id = this.nextId("RMA");
    const r: ReturnRecord = { id, order_id: orderId, sku, reason, label_url: `https://returns.larkspur-pine.example/${id}.pdf`, created_at: this.now().toISOString() };
    this.db.prepare("INSERT INTO returns VALUES (?,?,?,?,?,?)").run(r.id, r.order_id, r.sku, r.reason, r.label_url, r.created_at);
    return r;
  }
  appendTicketSummary(id: string, more: string) {
    this.db.prepare("UPDATE tickets SET summary = summary || ? WHERE id = ?").run(`\n\nFollow-up: ${more}`, id);
  }
  createTicket(customerId: string | null, reason: string, summary: string, priority: Ticket["priority"]): Ticket {
    const t: Ticket = { id: this.nextId("TCK"), customer_id: customerId, reason, summary, priority, created_at: this.now().toISOString() };
    this.db.prepare("INSERT INTO tickets VALUES (?,?,?,?,?,?)").run(t.id, t.customer_id, t.reason, t.summary, t.priority, t.created_at);
    return t;
  }
}

export function normalizeOrderId(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `LP-${digits}` : raw.trim().toUpperCase();
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
