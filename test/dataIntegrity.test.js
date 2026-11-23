import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { ObjectId } from "mongodb";

import createAdminRoutes from "../routes/adminRoutes.js";
import createMenuRoutes from "../routes/menuRoutes.js";
import createOrderRoutes from "../routes/orderRoutes.js";
import createWishlistRoutes from "../routes/wishlistRoutes.js";
import {
    ensureIndexes,
    INDEX_DEFINITIONS,
    verifyRequiredIndexes,
} from "../services/dbIndexes.js";
import { isPremium } from "../services/premiumStatus.js";

const ADMIN_ID = new ObjectId().toHexString();
const VENDOR_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();

const duplicateError = (keyPattern) =>
    Object.assign(new Error("E11000 duplicate key error"), {
        code: 11000,
        keyPattern,
    });

const sameValue = (actual, expected) => {
    if (actual instanceof ObjectId || expected instanceof ObjectId) {
        return String(actual) === String(expected);
    }

    if (actual instanceof Date || expected instanceof Date) {
        return new Date(actual).getTime() === new Date(expected).getTime();
    }

    return actual === expected;
};

const matches = (doc, query = {}) =>
    Object.entries(query).every(([field, expected]) => {
        const actual = doc[field];

        if (Array.isArray(expected) && field === "$and") {
            return expected.every((clause) => matches(doc, clause));
        }

        if (
            expected &&
            typeof expected === "object" &&
            !Array.isArray(expected) &&
            !(expected instanceof ObjectId) &&
            !(expected instanceof Date)
        ) {
            if ("$regex" in expected) {
                return new RegExp(
                    expected.$regex,
                    expected.$options || ""
                ).test(String(actual ?? ""));
            }

            if ("$in" in expected) {
                return expected.$in.some((value) => sameValue(actual, value));
            }

            if ("$nin" in expected) {
                return !expected.$nin.some((value) => sameValue(actual, value));
            }

            if ("$ne" in expected) {
                return !sameValue(actual, expected.$ne);
            }

            if ("$gte" in expected && !(actual >= expected.$gte)) {
                return false;
            }

            if ("$lte" in expected && !(actual <= expected.$lte)) {
                return false;
            }

            return true;
        }

        return sameValue(actual, expected);
    });

const compareValues = (left, right) => {
    const a = left instanceof ObjectId ? left.toString() : left;
    const b = right instanceof ObjectId ? right.toString() : right;

    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (a < b) return -1;
    if (a > b) return 1;

    return 0;
};

const resolveField = (doc, path) =>
    path.split(".").reduce((value, key) => value?.[key], doc);

const makeCollection = (initialDocs = [], options = {}) => {
    const docs = [...initialDocs];
    const uniqueFields = options.uniqueFields ?? [];

    const assertUnique = (candidate, exclude = null) => {
        if (uniqueFields.length === 0) {
            return;
        }

        const conflict = docs.some(
            (doc) =>
                doc !== exclude &&
                uniqueFields.every((field) =>
                    sameValue(doc[field], candidate[field])
                )
        );

        if (conflict) {
            throw duplicateError(
                Object.fromEntries(uniqueFields.map((field) => [field, 1]))
            );
        }
    };

    const applyUpdate = (doc, update = {}) => {
        for (const [field, value] of Object.entries(update.$set ?? {})) {
            doc[field] = value;
        }

        for (const [field, value] of Object.entries(update.$inc ?? {})) {
            doc[field] = (doc[field] ?? 0) + value;
        }
    };

    return {
        docs,

        createIndex: async (keys, indexOptions) => {
            options.indexes?.push({
                collection: options.name,
                keys,
                options: indexOptions,
            });

            return "index_name";
        },

        indexes: async () =>
            (options.indexes ?? [])
                .filter((index) => index.collection === options.name)
                .map((index) => ({
                    name: index.options?.name,
                    key: index.keys,
                    unique: index.options?.unique,
                    partialFilterExpression:
                        index.options?.partialFilterExpression,
                })),

        findOne: async (filter) =>
            docs.find((doc) => matches(doc, filter)) ?? null,

        find(filter = {}) {
            let sortSpec = null;
            let skipCount = 0;
            let limitCount = null;

            const cursor = {
                sort(spec) {
                    sortSpec = spec;
                    return cursor;
                },
                skip(count) {
                    skipCount = count;
                    return cursor;
                },
                limit(count) {
                    limitCount = count;
                    return cursor;
                },
                async toArray() {
                    let result = docs.filter((doc) => matches(doc, filter));

                    if (sortSpec) {
                        const fields = Object.entries(sortSpec);

                        result = [...result].sort((a, b) => {
                            for (const [field, direction] of fields) {
                                const order =
                                    compareValues(a[field], b[field]) *
                                    (direction === -1 ? -1 : 1);

                                if (order !== 0) return order;
                            }

                            return 0;
                        });
                    }

                    if (skipCount) result = result.slice(skipCount);

                    if (limitCount !== null) {
                        result = result.slice(0, limitCount);
                    }

                    return result;
                },
            };

            return cursor;
        },

        countDocuments: async (filter = {}) =>
            docs.filter((doc) => matches(doc, filter)).length,

        insertOne: async (doc) => {
            if (options.insertError) {
                throw options.insertError(doc);
            }

            assertUnique(doc);

            if (!doc._id) {
                doc._id = new ObjectId();
            }

            if (docs.some((existing) => sameValue(existing._id, doc._id))) {
                throw duplicateError({ _id: 1 });
            }

            docs.push(doc);

            return { insertedId: doc._id };
        },

        updateOne: async (filter, update, updateOptions = {}) => {
            const doc = docs.find((item) => matches(item, filter));

            if (!doc && updateOptions.upsert) {
                const inserted = {};

                for (const [field, value] of Object.entries(
                    update.$setOnInsert ?? {}
                )) {
                    inserted[field] = value;
                }

                applyUpdate(inserted, update);
                assertUnique(inserted);

                if (!inserted._id) {
                    inserted._id = new ObjectId();
                }

                docs.push(inserted);

                return {
                    matchedCount: 0,
                    modifiedCount: 0,
                    upsertedCount: 1,
                    upsertedId: inserted._id,
                };
            }

            if (!doc) {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            applyUpdate(doc, update);

            return { matchedCount: 1, modifiedCount: 1 };
        },

        findOneAndUpdate: async (filter, update) => {
            const doc = docs.find((item) => matches(item, filter));

            if (!doc) return null;

            const previous = { ...doc };
            applyUpdate(doc, update);

            return previous;
        },

        deleteOne: async (filter) => {
            const index = docs.findIndex((doc) => matches(doc, filter));

            if (index === -1) return { deletedCount: 0 };

            docs.splice(index, 1);

            return { deletedCount: 1 };
        },

        aggregate(pipeline = []) {
            const groupStage = pipeline.find((stage) => stage.$group);

            const evaluate = (doc, expression) => {
                if (Array.isArray(expression)) {
                    return expression.map((item) => evaluate(doc, item));
                }

                if (expression && typeof expression === "object") {
                    if ("$ifNull" in expression) {
                        for (const candidate of expression.$ifNull) {
                            const value = evaluate(doc, candidate);

                            if (value !== null && value !== undefined) {
                                return value;
                            }
                        }

                        return null;
                    }

                    if ("$convert" in expression) {
                        const value = evaluate(
                            doc,
                            expression.$convert.input
                        );
                        const converted = Number(value);

                        return Number.isFinite(converted)
                            ? converted
                            : (expression.$convert.onError ?? 0);
                    }

                    if ("$eq" in expression) {
                        return sameValue(
                            evaluate(doc, expression.$eq[0]),
                            evaluate(doc, expression.$eq[1])
                        );
                    }

                    if ("$ne" in expression) {
                        return !sameValue(
                            evaluate(doc, expression.$ne[0]),
                            evaluate(doc, expression.$ne[1])
                        );
                    }

                    if ("$in" in expression) {
                        const candidates = evaluate(doc, expression.$in[1]);

                        return candidates.some((candidate) =>
                            sameValue(
                                evaluate(doc, expression.$in[0]),
                                candidate
                            )
                        );
                    }

                    if ("$cond" in expression) {
                        const [condition, whenTrue, whenFalse] =
                            expression.$cond;

                        return evaluate(
                            doc,
                            evaluate(doc, condition) ? whenTrue : whenFalse
                        );
                    }

                    if ("$sum" in expression) {
                        const inner = expression.$sum;

                        if (typeof inner === "number") {
                            return inner * docs.length;
                        }

                        return docs.reduce(
                            (sum, item) =>
                                sum + Number(evaluate(item, inner) || 0),
                            0
                        );
                    }
                }

                if (
                    typeof expression === "string" &&
                    expression.startsWith("$")
                ) {
                    return resolveField(doc, expression.slice(1));
                }

                return expression;
            };

            return {
                async toArray() {
                    if (!groupStage) return [];

                    const result = {};

                    for (const [field, expression] of Object.entries(
                        groupStage.$group
                    )) {
                        if (field === "_id") continue;

                        result[field] = evaluate({}, expression);
                    }

                    return [result];
                },
            };
        },
    };
};

const makeDb = (collections = {}) => ({
    collection: (name) =>
        collections[name] ??
        makeCollection([], { name }),
});

const makeClient = () => ({
    startSession: () => ({
        withTransaction: async (callback) => callback({}),
        endSession: async () => {},
    }),
});

const sessionFor = (id, role) => ({
    user: {
        id,
        role,
        name: role,
        email: `${role}@example.test`,
    },
    session: { id: `session-${id}` },
});

const makeAuth = (sessions) => ({
    api: {
        getSession: async ({ headers }) => {
            const key = headers.get("x-test-session") || "none";
            return sessions[key] ?? null;
        },
    },
});

const startApp = async (configure) => {
    const app = express();
    app.use(express.json());
    configure(app);

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: async () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
    };
};

const request = (baseUrl, path, options = {}) => {
    const headers = {};

    if (options.session) {
        headers["x-test-session"] = options.session;
    }

    if (options.body !== undefined) {
        headers["content-type"] = "application/json";
    }

    return fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
            options.body === undefined
                ? undefined
                : JSON.stringify(options.body),
    });
};

const makePizza = (overrides = {}) => ({
    _id: new ObjectId(),
    name: "Test Pizza",
    description: "A test pizza",
    category: "Classic Pizzas",
    price: 12,
    location: "Dhaka",
    image: "https://example.test/pizza.png",
    vendorId: VENDOR_ID,
    vendor: "Test Vendor",
    status: "approved",
    isActive: true,
    isFeatured: false,
    isDeleted: false,
    createdAt: new Date(),
    ...overrides,
});

test("GET /api/menu supports server-side search, filters, price range, and sorting", async (t) => {
    const menu = makeCollection([
        makePizza({
            name: "Pepperoni Feast",
            category: "Classic Pizzas",
            location: "Dhaka",
            price: 14,
            isFeatured: true,
            createdAt: new Date("2026-01-01"),
        }),
        makePizza({
            name: "Garden Veggie",
            category: "Vegetarian Pizzas",
            location: "Sylhet",
            price: 10,
            createdAt: new Date("2026-01-02"),
        }),
        makePizza({
            name: "Pepperoni Lite",
            category: "Classic Pizzas",
            location: "Dhaka",
            price: 8,
            createdAt: new Date("2026-01-03"),
        }),
        makePizza({
            name: "Hidden Pending",
            status: "pending",
            createdAt: new Date("2026-01-04"),
        }),
    ]);
    const db = makeDb({ menuItems: menu });

    const app = await startApp((instance) => {
        instance.use(
            "/api/menu",
            createMenuRoutes(menu, makeAuth({}), db, makeClient())
        );
    });
    t.after(app.close);

    let response = await request(
        app.baseUrl,
        "/api/menu?search=pepperoni&category=Classic%20Pizzas&location=Dhaka&minPrice=9&sort=low"
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
        (await response.json()).map((item) => item.name),
        ["Pepperoni Feast"]
    );

    response = await request(app.baseUrl, "/api/menu?sort=low");
    assert.deepEqual(
        (await response.json()).map((item) => item.name),
        ["Pepperoni Lite", "Garden Veggie", "Pepperoni Feast"]
    );

    response = await request(app.baseUrl, "/api/menu?sort=high&maxPrice=12");
    assert.deepEqual(
        (await response.json()).map((item) => item.name),
        ["Garden Veggie", "Pepperoni Lite"]
    );

    response = await request(app.baseUrl, "/api/menu?search=.*");
    assert.deepEqual(await response.json(), []);

    response = await request(app.baseUrl, "/api/menu");
    assert.deepEqual(
        (await response.json()).map((item) => item.name),
        ["Pepperoni Feast", "Pepperoni Lite", "Garden Veggie"],
        "default ordering must remain featured-first"
    );
});

test("admin delete keeps historical order and review references", async (t) => {
    const pizzaId = new ObjectId();
    const menu = makeCollection([makePizza({ _id: pizzaId })]);
    const reviews = makeCollection([
        { _id: new ObjectId(), pizzaId, rating: 5 },
    ]);
    const orders = makeCollection([
        { _id: new ObjectId(), pizzaId: pizzaId.toString(), status: "delivered" },
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: menu,
        orders,
        reviews,
        transactions: makeCollection(),
    });
    const auth = makeAuth({ admin: sessionFor(ADMIN_ID, "admin") });

    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(db, auth, makeClient()));
    });
    t.after(app.close);

    const response = await request(
        app.baseUrl,
        `/api/admin/menu/${pizzaId}`,
        { method: "DELETE", session: "admin" }
    );

    assert.equal(response.status, 200);
    assert.equal(reviews.docs.length, 1);
    assert.equal(orders.docs.length, 1);
    assert.equal(menu.docs.length, 1);

    const deleted = await menu.findOne({ _id: pizzaId });
    assert.equal(deleted.isDeleted, true);
    assert.equal(
        deleted.adminPublished,
        false,
        "deletion must remove admin visibility without changing vendor availability"
    );
    assert.equal(deleted.isActive, true);
});

test("admin revenue excludes pending, rejected, and cancelled orders", async (t) => {
    const orders = makeCollection([
        { status: "pending", totalPrice: 5 },
        { status: "accepted", totalPrice: 10 },
        { status: "preparing", totalPrice: 20 },
        { status: "out_for_delivery", totalPrice: 30 },
        { status: "delivered", totalPrice: 40 },
        { status: "rejected", totalPrice: 999 },
        { status: "cancelled", totalPrice: 999 },
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: makeCollection(),
        orders,
        transactions: makeCollection(),
    });
    const auth = makeAuth({ admin: sessionFor(ADMIN_ID, "admin") });

    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(db, auth, makeClient()));
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/admin/stats", {
        session: "admin",
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.orders.revenue, 100);
    assert.equal(body.orders.total, 7);
});

test("wishlist is customer-only and duplicate upsert races are idempotent", async (t) => {
    const pizza = makePizza({ name: "Wishlist Pizza" });
    const users = makeCollection([
        {
            _id: new ObjectId(CUSTOMER_ID),
            role: "customer",
            blocked: false,
        },
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            blocked: false,
        },
    ]);
    const menuItems = makeCollection([pizza]);
    const wishlist = makeCollection();
    const originalUpdate = wishlist.updateOne.bind(wishlist);
    let updateCalls = 0;

    wishlist.updateOne = async (...args) => {
        updateCalls += 1;

        if (updateCalls === 1) {
            throw duplicateError({ customerId: 1, pizzaId: 1 });
        }

        return originalUpdate(...args);
    };

    const db = makeDb({ user: users, menuItems, wishlist });
    const auth = makeAuth({
        customer: sessionFor(CUSTOMER_ID, "customer"),
        vendor: sessionFor(VENDOR_ID, "vendor"),
    });

    const app = await startApp((instance) => {
        instance.use(
            "/api/wishlist",
            createWishlistRoutes(db, auth)
        );
    });
    t.after(app.close);

    for (const method of ["GET", "POST", "DELETE"]) {
        const response = await request(
            app.baseUrl,
            method === "DELETE" ? `/api/wishlist/${pizza._id}` : "/api/wishlist",
            {
                method,
                session: "vendor",
                body: method === "POST" ? { pizzaId: pizza._id.toString() } : undefined,
            }
        );

        assert.equal(response.status, 403, `${method} must reject vendors`);
    }

    const response = await request(app.baseUrl, "/api/wishlist", {
        method: "POST",
        session: "customer",
        body: { pizzaId: pizza._id.toString() },
    });

    assert.equal(response.status, 200);
    assert.equal(updateCalls, 1);
});

test("active-order insert race returns 409 from the unique-key fallback", async (t) => {
    const pizza = makePizza({ name: "Order Race Pizza" });
    const orders = makeCollection([], {
        insertError: () =>
            duplicateError({
                customerId: 1,
                pizzaId: 1,
                deliveryDateKey: 1,
            }),
    });
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(CUSTOMER_ID),
                role: "customer",
                blocked: false,
            },
        ]),
        menuItems: makeCollection([pizza]),
        orders,
    });
    const auth = makeAuth({ customer: sessionFor(CUSTOMER_ID, "customer") });

    const app = await startApp((instance) => {
        instance.use("/api/orders", createOrderRoutes(db, auth));
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body: {
            pizzaId: pizza._id.toString(),
            quantity: 1,
            deliveryAddress: "123 Test Street",
            deliveryDate: new Date(Date.now() + 86_400_000).toISOString(),
        },
    });

    assert.equal(response.status, 409);
    assert.equal(
        (await response.json()).message,
        "You already have an active order for this pizza on that delivery date"
    );
});

test("index definitions cover the new integrity constraints and query shapes", async () => {
    const orderIndex = INDEX_DEFINITIONS.find(
        (definition) => definition.name === "orders_unique_active_customer_pizza_date"
    );
    assert.ok(orderIndex, "one combined active-order index must exist");
    assert.equal(orderIndex.options.unique, true);
    assert.deepEqual(orderIndex.keys, {
        customerId: 1,
        pizzaId: 1,
        deliveryDateKey: 1,
    });
    assert.deepEqual(orderIndex.options.partialFilterExpression, {
        status: { $in: ["pending", "accepted", "preparing", "out_for_delivery"] },
    });

    for (const name of [
        "wishlist_customer_pizza_unique",
        "reviews_customer_pizza_unique",
        "transactions_stripe_event",
    ]) {
        const definition = INDEX_DEFINITIONS.find(
            (item) => item.name === name
        );
        assert.ok(definition, `${name} must be defined`);
        assert.equal(definition.options.unique, true);
    }

    const stripeEventDefinition = INDEX_DEFINITIONS.find(
        (definition) => definition.name === "transactions_stripe_event"
    );
    assert.deepEqual(stripeEventDefinition.options.partialFilterExpression, {
        stripeEventId: { $type: "string" },
    });

    const reviewUniqueDefinitions = INDEX_DEFINITIONS.filter(
        (definition) =>
            definition.collection === "reviews" &&
            definition.options.unique === true &&
            JSON.stringify(definition.keys) ===
                JSON.stringify({ customerId: 1, pizzaId: 1 })
    );
    assert.equal(
        reviewUniqueDefinitions.length,
        1,
        "reviews must have exactly one unique customer/pizza definition"
    );

    for (const name of [
        "menu_public_default",
        "menu_public_category",
        "menu_public_location",
        "menu_public_price",
        "menu_vendor_active",
        "orders_vendor_status_recent",
        "wishlist_customer_recent",
    ]) {
        assert.ok(
            INDEX_DEFINITIONS.some((item) => item.name === name),
            `${name} must be defined`
        );
    }

    const created = [];
    const db = {
        collection: (name) =>
            makeCollection([], {
                name,
                indexes: created,
            }),
    };
    const errors = [];
    const results = await ensureIndexes(db, {
        error: (message) => errors.push(message),
    });

    assert.equal(results.length, INDEX_DEFINITIONS.length);
    assert.ok(results.every((result) => result.ok));
    assert.equal(created.length, INDEX_DEFINITIONS.length);
    assert.deepEqual(errors, []);

    const verification = await verifyRequiredIndexes(db, {
        warn: () => {},
    }, { strict: true });
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.problems, []);
});

test("required index verification fails closed for duplicate-protection indexes", async () => {
    const db = {
        collection: () => ({ indexes: async () => [] }),
    };

    await assert.rejects(
        verifyRequiredIndexes(db, { warn: () => {} }, { strict: true }),
        /Required database indexes are missing or invalid/
    );
});

test("premium status honors expiry metadata without breaking legacy users", () => {
    const future = new Date(Date.now() + 86_400_000);

    assert.equal(isPremium({ plan: "premium" }), true);
    assert.equal(isPremium({ plan: "premium", premiumExpiresAt: future }), true);
    assert.equal(
        isPremium({
            plan: "premium",
            premiumExpiresAt: new Date(Date.now() - 1000),
        }),
        false
    );
    assert.equal(isPremium({ plan: "free" }), false);
    assert.equal(isPremium({ isPremium: true }), true);
});
