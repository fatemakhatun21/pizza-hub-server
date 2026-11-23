import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import "dotenv/config";
import { MongoClient, ServerApiVersion } from "mongodb";

import {
    INDEX_DEFINITIONS,
    indexSpecMatches,
    verifyRequiredIndexes,
} from "../services/dbIndexes.js";

/**
 * OPERATOR-RUN ONLY.
 *
 * This script is intentionally not imported by the application and is never
 * called at boot. It first runs read-only duplicate/type checks, aborts if any
 * conflict exists, and only then creates the declared indexes. Set both
 * MONGODB_URI and CONFIRM_INDEX_CREATE=yes before running it.
 */
const uri = process.env.MONGODB_URI;
const confirmation = process.env.CONFIRM_INDEX_CREATE;
const dbName = process.env.MONGODB_DB || "pizzahub_db";

if (!uri) {
    console.error("MONGODB_URI is missing from the environment.");
    process.exit(1);
}

if (confirmation !== "yes") {
    console.error(
        "Refusing to create indexes. Set CONFIRM_INDEX_CREATE=yes after completing the read-only checks."
    );
    process.exit(1);
}

const collect = async (collection, pipeline) =>
    db.collection(collection).aggregate(pipeline).toArray();

const duplicateGroups = async (collection, fields, match = {}) =>
    collect(collection, [
        { $match: match },
        {
            $group: {
                _id: Object.fromEntries(
                    fields.map((field) => [field, `$${field}`])
                ),
                count: { $sum: 1 },
                ids: { $push: "$_id" },
            },
        },
        { $match: { count: { $gt: 1 } } },
    ]);

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let db;

try {
    await client.connect();
    db = client.db(dbName);

    const conflicts = [];

    const uniqueTargets = [
        {
            collection: "orders",
            fields: ["customerId", "pizzaId", "deliveryDateKey"],
            match: { status: { $in: ["pending", "accepted", "preparing", "out_for_delivery"] } },
        },
        { collection: "wishlist", fields: ["customerId", "pizzaId"] },
        { collection: "reviews", fields: ["customerId", "pizzaId"] },
        { collection: "transactions", fields: ["stripeEventId"] },
    ];

    for (const target of uniqueTargets) {
        const duplicates = await duplicateGroups(
            target.collection,
            target.fields,
            target.match
        );

        if (duplicates.length) {
            conflicts.push({
                check: "duplicate_unique_keys",
                collection: target.collection,
                groups: duplicates,
            });
        }
    }

    const typeFields = [
        ["orders", "customerId"],
        ["orders", "pizzaId"],
        ["orders", "deliveryDateKey"],
        ["orders", "status"],
        ["wishlist", "customerId"],
        ["wishlist", "pizzaId"],
        ["reviews", "customerId"],
        ["reviews", "pizzaId"],
        ["transactions", "stripeEventId"],
        ["transactions", "stripeSessionId"],
        ["menuItems", "vendorId"],
    ];

    for (const [collection, field] of typeFields) {
        const types = await collect(collection, [
            {
                $group: {
                    _id: { $type: `$${field}` },
                    count: { $sum: 1 },
                },
            },
        ]);

        if (types.length > 1) {
            conflicts.push({
                check: "mixed_bson_types",
                collection,
                field,
                types,
            });
        }
    }

    const requiredKeys = [
        ["menuItems", ["vendorId", "status", "isActive"]],
        [
            "orders",
            ["customerId", "pizzaId", "deliveryDateKey", "status", "createdAt"],
        ],
        ["wishlist", ["customerId", "pizzaId"]],
        ["reviews", ["customerId", "pizzaId"]],
        ["transactions", ["stripeEventId"]],
    ];

    for (const [collection, fields] of requiredKeys) {
        const filter = { $or: fields.map((field) => ({ [field]: null })) };
        const count = await db.collection(collection).countDocuments(filter);

        if (count) {
            conflicts.push({
                check: "missing_or_null_keys",
                collection,
                fields,
                count,
            });
        }
    }

    const orderIndexes = await db.collection("orders").indexes();
    const obsoleteNames = [
        "orders_unique_pending_customer_pizza",
        "orders_unique_active_pending_customer_pizza_date",
        "orders_unique_active_accepted_customer_pizza_date",
    ];
    for (const oldName of obsoleteNames) {
        if (orderIndexes.some((index) => index?.name === oldName)) {
            conflicts.push({
                check: "obsolete_order_unique_index_requires_manual_review",
                collection: "orders",
                name: oldName,
                action: "After backup, duplicate review and deliveryDateKey backfill, have an operator retire the obsolete index in a controlled migration. No automatic drops are performed.",
            });
        }
    }

    const verification = await verifyRequiredIndexes(db, console, {
        strict: false,
        ignoreMissing: true,
    });

    if (!verification.ok) {
        conflicts.push({
            check: "existing_index_conflict",
            problems: verification.problems,
        });
    }

    if (conflicts.length) {
        console.error(
            "Index creation aborted. Resolve these read-only findings first:"
        );
        console.error(JSON.stringify(conflicts, null, 2));
        process.exitCode = 1;
    } else {
        for (const definition of INDEX_DEFINITIONS) {
            const indexes = await db.collection(definition.collection).indexes();
            const existing = indexes.find(
                (index) => index?.name === definition.name
            );

            if (indexSpecMatches(existing, definition)) {
                console.log(
                    `Already valid ${definition.collection}.${definition.name}`
                );
                continue;
            }

            await db
                .collection(definition.collection)
                .createIndex(definition.keys, definition.options);

            console.log(
                `Ensured ${definition.collection}.${definition.name}`
            );
        }

        const after = await verifyRequiredIndexes(db, console, {
            strict: true,
        });

        console.log(
            after.ok
                ? "All required indexes are present and valid."
                : "Index verification failed after creation."
        );
        process.exitCode = after.ok ? 0 : 1;
    }
} catch (error) {
    console.error("Index maintenance failed:", error.message);
    process.exitCode = 1;
} finally {
    await client.close();
}
