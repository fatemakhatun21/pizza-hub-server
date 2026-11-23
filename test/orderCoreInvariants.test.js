import test from "node:test";
import assert from "node:assert/strict";
import { INDEX_DEFINITIONS } from "../services/dbIndexes.js";
import { ACTIVE_ORDER_STATUSES, getDeliveryDateKey, normalizeOrderMessage } from "../utils/orderRules.js";

const activeOrderIndex = INDEX_DEFINITIONS.find(
    ({ name }) => name === "orders_unique_active_customer_pizza_date"
);

test("one partial unique index protects duplicates across all active order statuses", () => {
    assert.ok(activeOrderIndex);
    assert.equal(activeOrderIndex.options.unique, true);
    assert.deepEqual(activeOrderIndex.keys, {
        customerId: 1,
        pizzaId: 1,
        deliveryDateKey: 1,
    });
    assert.deepEqual(activeOrderIndex.options.partialFilterExpression, {
        status: { $in: ACTIVE_ORDER_STATUSES },
    });
    assert.ok(ACTIVE_ORDER_STATUSES.includes("accepted"));
    assert.ok(ACTIVE_ORDER_STATUSES.includes("preparing"));
});

test("server computes delivery date key from delivery date, not supplied key", () => {
    const date = "2027-03-10T12:00:00.000Z";
    assert.equal(getDeliveryDateKey(date, "2099-01-01"), "2027-03-10");
    assert.equal(getDeliveryDateKey("invalid-date"), "");
});

test("optional special instructions are normalized and length-limited", () => {
    assert.deepEqual(normalizeOrderMessage("  Extra sauce "), { ok: true, value: "Extra sauce" });
    assert.deepEqual(normalizeOrderMessage(undefined), { ok: true, value: "" });
    assert.equal(normalizeOrderMessage("x".repeat(501)).ok, false);
});
