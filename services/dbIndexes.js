/**
 * Index definitions for the queries and integrity rules used by PizzaHub.
 *
 * Runtime startup never creates indexes. `verifyRequiredIndexes` performs a
 * read-only metadata check so a missing integrity constraint cannot silently
 * disable duplicate protection. `ensureIndexes` remains available only for an
 * explicit, operator-run maintenance task; it must not be called from app boot.
 */
export const INDEX_DEFINITIONS = [
    {
        collection: "menuItems",
        name: "menu_public_default",
        keys: { status: 1, isActive: 1, isFeatured: -1, createdAt: -1 },
        options: { name: "menu_public_default" },
    },
    {
        collection: "menuItems",
        name: "menu_public_category",
        keys: { status: 1, isActive: 1, category: 1, createdAt: -1 },
        options: { name: "menu_public_category" },
    },
    {
        collection: "menuItems",
        name: "menu_public_location",
        keys: { status: 1, isActive: 1, location: 1, createdAt: -1 },
        options: { name: "menu_public_location" },
    },
    {
        collection: "menuItems",
        name: "menu_public_price",
        keys: { status: 1, isActive: 1, price: 1 },
        options: { name: "menu_public_price" },
    },
    {
        collection: "menuItems",
        name: "menu_vendor_active",
        keys: { vendorId: 1, status: 1, isActive: 1 },
        options: { name: "menu_vendor_active" },
    },
    {
        collection: "menuItems",
        name: "menu_vendor_created",
        keys: { vendorId: 1, createdAt: -1 },
        options: { name: "menu_vendor_created" },
    },
    {
        collection: "menuItems",
        name: "menu_soft_deleted",
        keys: { isDeleted: 1, updatedAt: -1 },
        options: { name: "menu_soft_deleted" },
    },
    {
        collection: "orders",
        name: "orders_customer_recent",
        keys: { customerId: 1, createdAt: -1 },
        options: { name: "orders_customer_recent" },
    },
    {
        collection: "orders",
        name: "orders_vendor_status_recent",
        keys: { vendorId: 1, status: 1, createdAt: -1 },
        options: { name: "orders_vendor_status_recent" },
    },
    {
        collection: "orders",
        name: "orders_status_recent",
        keys: { status: 1, createdAt: -1 },
        options: { name: "orders_status_recent" },
    },
    {
        collection: "orders",
        name: "orders_unique_active_customer_pizza_date",
        keys: { customerId: 1, pizzaId: 1, deliveryDateKey: 1 },
        options: {
            name: "orders_unique_active_customer_pizza_date",
            unique: true,
            // One index across both statuses: separate indexes permit
            // one pending AND one accepted order for the same delivery date.
            partialFilterExpression: { status: { $in: ["pending", "accepted", "preparing", "out_for_delivery"] } },
        },
    },
    {
        collection: "wishlist",
        name: "wishlist_customer_pizza_unique",
        keys: { customerId: 1, pizzaId: 1 },
        options: {
            name: "wishlist_customer_pizza_unique",
            unique: true,
        },
    },
    {
        collection: "wishlist",
        name: "wishlist_customer_recent",
        keys: { customerId: 1, createdAt: -1 },
        options: { name: "wishlist_customer_recent" },
    },
    {
        collection: "reviews",
        name: "reviews_customer_pizza_unique",
        keys: { customerId: 1, pizzaId: 1 },
        options: {
            name: "reviews_customer_pizza_unique",
            unique: true,
        },
    },
    {
        collection: "reviews",
        name: "reviews_pizza_recent",
        keys: { pizzaId: 1, createdAt: -1 },
        options: { name: "reviews_pizza_recent" },
    },
    {
        collection: "transactions",
        name: "transactions_stripe_session",
        keys: { stripeSessionId: 1 },
        options: { name: "transactions_stripe_session" },
    },
    {
        collection: "transactions",
        name: "transactions_stripe_event",
        keys: { stripeEventId: 1 },
        options: {
            name: "transactions_stripe_event",
            unique: true,
            partialFilterExpression: { stripeEventId: { $type: "string" } },
        },
    },
    {
        collection: "transactions",
        name: "transactions_recent",
        keys: { createdAt: -1 },
        options: { name: "transactions_recent" },
    },
];

export const CRITICAL_INDEX_NAMES = new Set([
    "orders_unique_active_customer_pizza_date",
    "wishlist_customer_pizza_unique",
    "reviews_customer_pizza_unique",
    "transactions_stripe_event",
]);

const BSON_TYPE_CODES = new Map([
    [-1, "minkey"],
    [1, "double"],
    [2, "string"],
    [3, "object"],
    [4, "array"],
    [5, "bindata"],
    [6, "undefined"],
    [7, "objectid"],
    [8, "bool"],
    [9, "date"],
    [10, "null"],
    [11, "regex"],
    [12, "dbpointer"],
    [13, "javascript"],
    [14, "symbol"],
    [15, "javascriptwithscope"],
    [16, "int"],
    [17, "timestamp"],
    [18, "long"],
    [19, "decimal"],
    [127, "maxkey"],
]);

function flattenAnd(value) {
    const flattened = {};

    for (const [key, entry] of Object.entries(value)) {
        if (key === "$and" && Array.isArray(entry)) {
            for (const clause of entry) {
                if (!clause || typeof clause !== "object" || Array.isArray(clause)) {
                    return value;
                }

                for (const [nestedKey, nestedValue] of Object.entries(
                    flattenAnd(clause)
                )) {
                    if (Object.prototype.hasOwnProperty.call(flattened, nestedKey)) {
                        return value;
                    }
                    flattened[nestedKey] = nestedValue;
                }
            }
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(flattened, key)) {
            return value;
        }
        flattened[key] = entry;
    }

    return flattened;
}

function canonicalizeTypeSelector(value) {
    const tokens = Array.isArray(value) ? value : [value];

    const normalized = tokens.map((token) => {
        if (typeof token === "number" && Number.isInteger(token)) {
            return BSON_TYPE_CODES.get(token) ?? `code:${token}`;
        }

        if (typeof token === "string") {
            return token.toLowerCase();
        }

        return JSON.stringify(canonicalizeValue(token));
    });

    return {
        t: "typeSelector",
        v: [...new Set(normalized)].sort(),
    };
}

function canonicalizeSetOperator(value) {
    if (!Array.isArray(value)) {
        return canonicalizeValue(value);
    }

    return {
        t: "set",
        v: [...new Set(value.map((item) => JSON.stringify(canonicalizeValue(item))))].sort(),
    };
}

function canonicalizeClauseSet(value) {
    if (!Array.isArray(value)) {
        return canonicalizeValue(value);
    }

    return {
        t: "clauseSet",
        v: value
            .map((clause) => JSON.stringify(canonicalizeValue(clause)))
            .sort(),
    };
}

/**
 * Produce a stable representation of a BSON/MQL value. Only semantically
 * equivalent forms are merged: field order in filter documents, `$in` order,
 * `$type` aliases/codes and `$and` clause order. Array order elsewhere and
 * index key order are preserved because both are significant.
 */
function canonicalizeValue(value) {
    if (value === undefined) return { t: "undefined" };
    if (value === null) return { t: "null" };

    if (value instanceof Date) {
        return { t: "date", v: Number.isNaN(value.getTime()) ? String(value) : value.toISOString() };
    }

    if (value instanceof RegExp) {
        return { t: "regex", v: value.source, flags: value.flags };
    }

    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return { t: typeof value, v: value };
    }

    if (typeof value === "bigint") {
        return { t: "number", v: Number(value) };
    }

    if (Array.isArray(value)) {
        return { t: "array", v: value.map((item) => canonicalizeValue(item)) };
    }

    const bsonType = value?._bsontype;

    switch (bsonType) {
        case "ObjectId":
            return { t: "objectId", v: value.toHexString?.() ?? String(value) };
        case "Int32":
        case "Double":
            return { t: "number", v: Number(value.value ?? value) };
        case "Long": {
            const numeric = Number(value.toString());
            return Number.isSafeInteger(numeric)
                ? { t: "number", v: numeric }
                : { t: "long", v: value.toString() };
        }
        case "Decimal128":
            return { t: "decimal", v: value.toString() };
        case "Timestamp":
            return { t: "timestamp", v: value.toString() };
        case "Binary":
            return {
                t: "binary",
                v: Buffer.from(value.buffer ?? []).toString("base64"),
                subtype: value.sub_type,
            };
        case "BSONSymbol":
            return { t: "symbol", v: value.value ?? String(value) };
        case "Code":
            return { t: "code", v: String(value.code ?? value) };
        case "MinKey":
            return { t: "minkey" };
        case "MaxKey":
            return { t: "maxkey" };
        default:
            break;
    }

    if (typeof value.toHexString === "function") {
        return { t: "objectId", v: value.toHexString() };
    }

    if (typeof value !== "object") {
        return { t: "unknown", v: String(value) };
    }

    const entries = Object.entries(flattenAnd(value))
        .map(([key, entry]) => {
            if (key === "$type") return [key, canonicalizeTypeSelector(entry)];
            if (key === "$in" || key === "$nin") return [key, canonicalizeSetOperator(entry)];
            if (key === "$and" || key === "$or" || key === "$nor") {
                return [key, canonicalizeClauseSet(entry)];
            }
            return [key, canonicalizeValue(entry)];
        })
        .sort(([left], [right]) => left.localeCompare(right));

    return { t: "object", v: entries };
}

function canonicalizeDirection(value) {
    if (value === "asc" || value === "ascending") return canonicalizeValue(1);
    if (value === "desc" || value === "descending") return canonicalizeValue(-1);
    return canonicalizeValue(value);
}

function canonicalizeKeys(keys) {
    return JSON.stringify(
        Object.entries(keys ?? {}).map(([field, direction]) => [
            field,
            canonicalizeDirection(direction),
        ])
    );
}

function canonicalizePartialFilter(value) {
    if (value === undefined || value === null) return null;
    return JSON.stringify(canonicalizeValue(value));
}

/**
 * Compare an existing index against its required definition without treating
 * equivalent MongoDB metadata spellings as conflicts. This never ignores the
 * index keys, `unique`, or the presence/absence of a partial filter.
 */
export function indexSpecMatches(existing, definition) {
    if (!existing || !definition) return false;

    const options = definition.options ?? {};

    return (
        canonicalizeKeys(existing.key) === canonicalizeKeys(definition.keys) &&
        (existing.unique === true) === (options.unique === true) &&
        canonicalizePartialFilter(existing.partialFilterExpression) ===
            canonicalizePartialFilter(options.partialFilterExpression)
    );
}

export async function verifyRequiredIndexes(
    db,
    logger = console,
    {
        strict = process.env.NODE_ENV === "production",
        ignoreMissing = false,
    } = {}
) {
    const problems = [];

    for (const definition of INDEX_DEFINITIONS) {
        if (!CRITICAL_INDEX_NAMES.has(definition.name)) {
            continue;
        }

        let indexes = [];

        try {
            indexes = await db.collection(definition.collection).indexes();
        } catch (error) {
            problems.push(
                `${definition.collection}.${definition.name}: metadata read failed (${error.message})`
            );
            continue;
        }

        const existing = indexes.find(
            (index) => index?.name === definition.name
        );

        if (!existing) {
            if (!ignoreMissing) {
                problems.push(
                    `${definition.collection}.${definition.name}: required index is missing`
                );
            }
            continue;
        }

        if (!indexSpecMatches(existing, definition)) {
            problems.push(
                `${definition.collection}.${definition.name}: existing index spec does not match the required definition (keys, unique, or partialFilterExpression)`
            );
        }
    }

    if (problems.length === 0) {
        return { ok: true, problems: [], strict };
    }

    const message =
        "Required database indexes are missing or invalid: " +
        problems.join("; ") +
        ". Run the documented read-only verification and pre-create indexes during a controlled maintenance window before deploying.";

    if (strict) {
        throw new Error(message);
    }

    logger.warn?.(message);

    return { ok: false, problems, strict };
}

export async function ensureIndexes(db, logger = console) {
    const results = await Promise.all(
        INDEX_DEFINITIONS.map(async (definition) => {
            try {
                await db
                    .collection(definition.collection)
                    .createIndex(definition.keys, definition.options);

                return { ...definition, ok: true };
            } catch (error) {
                const message =
                    definition.name && definition.collection
                        ? `Index ${definition.collection}.${definition.name} could not be created: ${error.message}`
                        : `Index creation failed: ${error.message}`;

                logger.error?.(message);

                return { ...definition, ok: false, error };
            }
        })
    );

    return results;
}
