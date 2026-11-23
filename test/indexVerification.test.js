import test from "node:test";
import assert from "node:assert/strict";

import {
    CRITICAL_INDEX_NAMES,
    INDEX_DEFINITIONS,
    indexSpecMatches,
    verifyRequiredIndexes,
} from "../services/dbIndexes.js";

const definitionByName = (name) =>
    INDEX_DEFINITIONS.find((definition) => definition.name === name);

const asExisting = (definition) => ({
    collection: definition.collection,
    name: definition.name,
    key: definition.keys,
    unique: definition.options.unique,
    partialFilterExpression: definition.options.partialFilterExpression,
});

const makeDb = (overrides = {}) => {
    const specs = INDEX_DEFINITIONS.filter((definition) =>
        CRITICAL_INDEX_NAMES.has(definition.name)
    ).map(asExisting);

    for (const [name, patch] of Object.entries(overrides)) {
        const index = specs.find((spec) => spec.name === name);
        assert.ok(index, `unknown critical index ${name}`);
        Object.assign(index, patch);
    }

    return {
        collection: (name) => ({
            indexes: async () => specs.filter((spec) => spec.collection === name),
        }),
    };
};

const verify = async (db) =>
    verifyRequiredIndexes(db, { warn: () => {} }, { strict: false });

test("verification accepts semantically equivalent MongoDB partial-filter metadata", async () => {
    const cases = [
        {
            name: "transactions_stripe_event",
            partialFilterExpression: { stripeEventId: { $type: 2 } },
        },
        {
            name: "transactions_stripe_event",
            partialFilterExpression: { stripeEventId: { $type: ["string"] } },
        },
        {
            name: "transactions_stripe_event",
            partialFilterExpression: {
                $and: [{ stripeEventId: { $type: "String" } }],
            },
        },
        {
            name: "orders_unique_active_customer_pizza_date",
            partialFilterExpression: {
                status: {
                    $in: ["out_for_delivery", "preparing", "accepted", "pending"],
                },
            },
        },
    ];

    for (const patch of cases) {
        const result = await verify(makeDb({ [patch.name]: patch }));
        assert.deepEqual(result.problems, []);
        assert.equal(result.ok, true);
    }
});

test("verification still rejects weaker or different index specs", async () => {
    const cases = [
        {
            name: "transactions_stripe_event",
            patch: { partialFilterExpression: { stripeEventId: { $type: "number" } } },
        },
        {
            name: "transactions_stripe_event",
            patch: { partialFilterExpression: undefined },
        },
        {
            name: "orders_unique_active_customer_pizza_date",
            patch: {
                partialFilterExpression: {
                    status: { $in: ["pending", "accepted"] },
                },
            },
        },
        {
            name: "reviews_customer_pizza_unique",
            patch: { unique: false },
        },
        {
            name: "reviews_customer_pizza_unique",
            patch: { key: { pizzaId: 1, customerId: 1 } },
        },
    ];

    for (const { name, patch } of cases) {
        const result = await verify(makeDb({ [name]: patch }));
        assert.equal(result.ok, false);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], new RegExp(name));
    }
});

test("index spec comparison preserves key order, uniqueness and partial filters", () => {
    const definition = definitionByName("transactions_stripe_event");
    const existing = asExisting(definition);

    assert.equal(indexSpecMatches(existing, definition), true);
    assert.equal(
        indexSpecMatches(
            { ...existing, key: { pizzaId: 1, customerId: 1 } },
            definitionByName("reviews_customer_pizza_unique")
        ),
        false
    );
    assert.equal(indexSpecMatches({ ...existing, unique: false }, definition), false);
    assert.equal(
        indexSpecMatches({ ...existing, partialFilterExpression: undefined }, definition),
        false
    );
});
