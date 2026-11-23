import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { ObjectId } from "mongodb";

import createAdminRoutes from "../routes/adminRoutes.js";
import createMenuRoutes from "../routes/menuRoutes.js";
import createOrderRoutes from "../routes/orderRoutes.js";
import { buildCheckoutUrls } from "../routes/billingRoutes.js";
import {
    PASSWORD_RULE_MESSAGE,
    readSignupBody,
    requireStrongSignupPassword,
    validatePasswordStrength,
} from "../middleware/signupPassword.js";
import { apiNotFound } from "../middleware/apiNotFound.js";
import { normalizeMenuImages, withMenuImages } from "../utils/menuImages.js";
import {
    ACTIVE_ORDER_STATUSES,
    getDeliveryDateKey,
    normalizeOrderMessage,
} from "../utils/orderRules.js";
import { INDEX_DEFINITIONS } from "../services/dbIndexes.js";

const ADMIN_ID = new ObjectId().toHexString();
const VENDOR_ID = new ObjectId().toHexString();
const OTHER_VENDOR_ID = new ObjectId().toHexString();
const CUSTOMER_ID = new ObjectId().toHexString();

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

        if (
            expected &&
            typeof expected === "object" &&
            !Array.isArray(expected) &&
            !(expected instanceof ObjectId) &&
            !(expected instanceof Date)
        ) {
            if ("$in" in expected) {
                return expected.$in.some((value) => sameValue(actual, value));
            }

            if ("$nin" in expected) {
                return !expected.$nin.some((value) => sameValue(actual, value));
            }

            if ("$ne" in expected) {
                return !sameValue(actual, expected.$ne);
            }
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

const makeCollection = (initialDocs = []) => {
    const docs = [...initialDocs];

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

        aggregate: () => ({
            toArray: async () => [{}],
        }),

        insertOne: async (doc) => {
            docs.push(doc);
            return { insertedId: doc._id ?? new ObjectId() };
        },

        updateOne: async (filter, update) => {
            const doc = docs.find((item) => matches(item, filter));

            if (!doc) {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            applyUpdate(doc, update);

            return { matchedCount: 1, modifiedCount: 1 };
        },

        findOneAndUpdate: async (filter, update, options = {}) => {
            const doc = docs.find((item) => matches(item, filter));

            if (!doc) return null;

            const previous = { ...doc };
            applyUpdate(doc, update);

            return options.returnDocument === "after" ? doc : previous;
        },

        deleteOne: async (filter) => {
            const index = docs.findIndex((doc) => matches(doc, filter));

            if (index === -1) return { deletedCount: 0 };

            docs.splice(index, 1);

            return { deletedCount: 1 };
        },
    };
};

const makeDb = (collections) => ({
    collection: (name) => collections[name] ?? makeCollection(),
});

const dbFor = (users, menuItems) =>
    makeDb({
        user: users,
        menuItems,
        orders: makeCollection(),
        transactions: makeCollection(),
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
    category: "Pizza",
    description: "Test description",
    price: 12,
    location: "Test City",
    image: "https://example.test/pizza.png",
    vendorId: VENDOR_ID,
    vendor: "Test Vendor",
    status: "approved",
    isActive: true,
    isFeatured: false,
    createdAt: new Date(),
    ...overrides,
});

test("admin can publish, unpublish, and delete pizzas with role protection", async (t) => {
    const targetId = new ObjectId();
    const menu = makeCollection([
        makePizza({
            _id: targetId,
            name: "Target",
            isActive: true,
            adminPublished: false,
        }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "premium",
            blocked: false,
        },
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
        {
            _id: new ObjectId(CUSTOMER_ID),
            role: "customer",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: menu,
        orders: makeCollection(),
        transactions: makeCollection(),
    });
    const auth = makeAuth({
        admin: sessionFor(ADMIN_ID, "admin"),
        customer: sessionFor(CUSTOMER_ID, "customer"),
    });

    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(db, auth, makeClient()));
        instance.use("/api/menu", createMenuRoutes(menu, auth, db, makeClient()));
    });
    t.after(app.close);

    let response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}/availability`,
        {
            method: "PATCH",
            session: "customer",
            body: { isActive: true },
        }
    );
    assert.equal(response.status, 403);

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}/availability`,
        {
            method: "PATCH",
            session: "admin",
            body: { isActive: true },
        }
    );
    assert.equal(response.status, 200);
    const published = await menu.findOne({ _id: targetId });
    assert.equal(
        published.adminPublished,
        true,
        "publish must set admin visibility"
    );
    assert.equal(published.isActive, true, "vendor availability is unchanged");

    response = await request(app.baseUrl, "/api/menu");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, 1);

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}/availability`,
        {
            method: "PATCH",
            session: "admin",
            body: { isActive: false },
        }
    );
    assert.equal(response.status, 200);
    assert.equal(
        (await menu.findOne({ _id: targetId })).adminPublished,
        false,
        "unpublish must clear admin visibility"
    );

    response = await request(app.baseUrl, "/api/menu");
    assert.deepEqual(await response.json(), [], "unpublished pizzas must leave public listings");

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}`,
        {
            method: "DELETE",
            session: "customer",
        }
    );
    assert.equal(response.status, 403);

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}`,
        {
            method: "DELETE",
            session: "admin",
        }
    );
    assert.equal(response.status, 200);

    // Deletion is soft: the document remains for historical references but is
    // no longer active or visible through any public/vendor/admin query.
    const deleted = await menu.findOne({ _id: targetId });
    assert.ok(deleted, "soft deletion must keep the historical document");
    assert.equal(deleted.isDeleted, true);
    assert.equal(deleted.adminPublished, false);
    assert.equal(deleted.isActive, true);
    assert.equal(deleted.deletedBy, ADMIN_ID);

    response = await request(app.baseUrl, "/api/menu");
    assert.deepEqual(
        await response.json(),
        [],
        "soft-deleted pizzas must leave the public menu"
    );
});

test("publishing a free vendor pizza uses the atomic three-item limit", async (t) => {
    const targetId = new ObjectId();
    const menu = makeCollection([
        makePizza({
            _id: targetId,
            name: "Target",
            isActive: true,
            adminPublished: false,
        }),
        makePizza({ name: "Active 1" }),
        makePizza({ name: "Active 2" }),
        makePizza({ name: "Active 3" }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "free",
            blocked: false,
        },
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: menu,
        orders: makeCollection(),
        transactions: makeCollection(),
    });
    const auth = makeAuth({ admin: sessionFor(ADMIN_ID, "admin") });

    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(db, auth, makeClient()));
    });
    t.after(app.close);

    const response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}/availability`,
        {
            method: "PATCH",
            session: "admin",
            body: { isActive: true },
        }
    );

    assert.equal(response.status, 403);
    assert.match((await response.json()).message, /at most 3 active pizzas/i);
    assert.equal(
        (await menu.findOne({ _id: targetId })).adminPublished,
        false,
        "a rejected publish must leave admin visibility unchanged"
    );
});

test("admin unpublish frees a free-vendor slot and republish consumes it again", async (t) => {
    const unpublishedId = new ObjectId();
    const replacementId = new ObjectId();
    const menu = makeCollection([
        makePizza({ name: "Active 1", adminPublished: true }),
        makePizza({ name: "Active 2", adminPublished: true }),
        makePizza({
            _id: unpublishedId,
            name: "Will Unpublish",
            adminPublished: true,
        }),
        makePizza({
            _id: replacementId,
            name: "Replacement",
            isActive: false,
            adminPublished: true,
        }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "free",
            blocked: false,
        },
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const auth = makeAuth({
        admin: sessionFor(ADMIN_ID, "admin"),
        vendor: sessionFor(VENDOR_ID, "vendor"),
    });
    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(dbFor(users, menu), auth, makeClient()));
        instance.use(
            "/api/menu",
            createMenuRoutes(menu, auth, dbFor(users, menu), makeClient())
        );
    });
    t.after(app.close);

    let response = await request(
        app.baseUrl,
        `/api/admin/menu/${unpublishedId}/availability`,
        { method: "PATCH", session: "admin", body: { isActive: false } }
    );
    assert.equal(response.status, 200);

    response = await request(
        app.baseUrl,
        `/api/menu/${replacementId}/availability`,
        { method: "PATCH", session: "vendor", body: { isActive: true } }
    );
    assert.equal(response.status, 200, "unpublished items must not hold slots");
    assert.equal(
        (await menu.findOne({ _id: replacementId })).isActive,
        true
    );

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${unpublishedId}/availability`,
        { method: "PATCH", session: "admin", body: { isActive: true } }
    );
    assert.equal(response.status, 403, "republish must respect the 3-slot cap");

    response = await request(
        app.baseUrl,
        `/api/menu/${replacementId}/availability`,
        { method: "PATCH", session: "vendor", body: { isActive: false } }
    );
    assert.equal(response.status, 200);

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${unpublishedId}/availability`,
        { method: "PATCH", session: "admin", body: { isActive: true } }
    );
    assert.equal(response.status, 200, "a freed slot must allow republish");
});

test("admin soft delete frees a free-vendor slot", async (t) => {
    const deletedId = new ObjectId();
    const replacementId = new ObjectId();
    const menu = makeCollection([
        makePizza({ name: "Active 1", adminPublished: true }),
        makePizza({ name: "Active 2", adminPublished: true }),
        makePizza({
            _id: deletedId,
            name: "Will Delete",
            adminPublished: true,
        }),
        makePizza({
            _id: replacementId,
            name: "Replacement",
            isActive: false,
            adminPublished: true,
        }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "free",
            blocked: false,
        },
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const auth = makeAuth({
        admin: sessionFor(ADMIN_ID, "admin"),
        vendor: sessionFor(VENDOR_ID, "vendor"),
    });
    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(dbFor(users, menu), auth, makeClient()));
        instance.use(
            "/api/menu",
            createMenuRoutes(menu, auth, dbFor(users, menu), makeClient())
        );
    });
    t.after(app.close);

    let response = await request(
        app.baseUrl,
        `/api/admin/menu/${deletedId}`,
        { method: "DELETE", session: "admin" }
    );
    assert.equal(response.status, 200);
    assert.equal((await menu.findOne({ _id: deletedId })).isDeleted, true);

    response = await request(
        app.baseUrl,
        `/api/menu/${replacementId}/availability`,
        { method: "PATCH", session: "vendor", body: { isActive: true } }
    );
    assert.equal(response.status, 200, "deleted items must not hold slots");
});

test("admin publish does not override vendor unavailability", async (t) => {
    const targetId = new ObjectId();
    const menu = makeCollection([
        makePizza({
            _id: targetId,
            name: "Vendor Unavailable",
            isActive: false,
            adminPublished: false,
        }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "free",
            blocked: false,
        },
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: menu,
        orders: makeCollection(),
        transactions: makeCollection(),
    });
    const auth = makeAuth({ admin: sessionFor(ADMIN_ID, "admin") });

    const app = await startApp((instance) => {
        instance.use("/api/admin", createAdminRoutes(db, auth, makeClient()));
        instance.use("/api/menu", createMenuRoutes(menu, auth, db, makeClient()));
    });
    t.after(app.close);

    const response = await request(
        app.baseUrl,
        `/api/admin/menu/${targetId}/availability`,
        {
            method: "PATCH",
            session: "admin",
            body: { isActive: true },
        }
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.adminPublished, true);
    assert.equal(body.vendorAvailable, false);
    assert.equal(body.publiclyVisible, false);

    const updated = await menu.findOne({ _id: targetId });
    assert.equal(updated.isActive, false, "vendor availability must be preserved");
    assert.equal(updated.adminPublished, true);

    const publicResponse = await request(app.baseUrl, "/api/menu");
    assert.deepEqual(
        await publicResponse.json(),
        [],
        "admin publication alone must not make an unavailable pizza public"
    );
});

test("admin availability endpoint rejects pizzas that are not approved", async (t) => {
    const pendingId = new ObjectId();
    const menu = makeCollection([
        makePizza({ _id: pendingId, status: "pending", isActive: false }),
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
        orders: makeCollection(),
        transactions: makeCollection(),
    });

    const app = await startApp((instance) => {
        instance.use(
            "/api/admin",
            createAdminRoutes(db, makeAuth({ admin: sessionFor(ADMIN_ID, "admin") }), makeClient())
        );
    });
    t.after(app.close);

    const response = await request(
        app.baseUrl,
        `/api/admin/menu/${pendingId}/availability`,
        {
            method: "PATCH",
            session: "admin",
            body: { isActive: true },
        }
    );

    assert.equal(response.status, 409);
});

test("vendors cannot modify pizzas owned by another vendor", async (t) => {
    const pizza = makePizza({ vendorId: VENDOR_ID });
    const menu = makeCollection([pizza]);
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(OTHER_VENDOR_ID),
                role: "vendor",
                plan: "premium",
                blocked: false,
            },
        ]),
        menuItems: menu,
    });
    const auth = makeAuth({
        otherVendor: sessionFor(OTHER_VENDOR_ID, "vendor"),
    });

    const app = await startApp((instance) => {
        instance.use("/api/menu", createMenuRoutes(menu, auth, db, makeClient()));
    });
    t.after(app.close);

    let response = await request(app.baseUrl, `/api/menu/${pizza._id}`, {
        method: "PATCH",
        session: "otherVendor",
        body: { name: "Stolen Pizza" },
    });
    assert.equal(response.status, 403);
    assert.equal((await menu.findOne({ _id: pizza._id })).name, "Test Pizza");

    response = await request(app.baseUrl, `/api/menu/${pizza._id}`, {
        method: "DELETE",
        session: "otherVendor",
    });
    assert.equal(response.status, 404);
    assert.equal(menu.docs.length, 1);
});

test("featured menu returns only approved, active pizzas up to the requested limit", async (t) => {
    const qualifyingFeatured = makePizza({
        name: "Featured",
        isFeatured: true,
        createdAt: new Date("2026-01-05"),
    });
    const qualifyingFiller = makePizza({
        name: "Filler",
        createdAt: new Date("2026-01-04"),
    });
    const rejected = makePizza({
        name: "Rejected",
        status: "rejected",
        isFeatured: true,
        createdAt: new Date("2026-01-06"),
    });
    const inactive = makePizza({
        name: "Inactive",
        isActive: false,
        isFeatured: true,
        createdAt: new Date("2026-01-07"),
    });
    const pending = makePizza({
        name: "Pending",
        status: "pending",
        isFeatured: true,
        createdAt: new Date("2026-01-08"),
    });

    const menu = makeCollection([
        qualifyingFeatured,
        qualifyingFiller,
        rejected,
        inactive,
        pending,
    ]);
    const db = makeDb({ user: makeCollection(), menuItems: menu });

    const app = await startApp((instance) => {
        instance.use("/api/menu", createMenuRoutes(menu, makeAuth({}), db, makeClient()));
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/menu/featured?limit=6");
    assert.equal(response.status, 200);

    const names = (await response.json()).map((item) => item.name).sort();
    assert.deepEqual(names, ["Featured", "Filler"]);
});

test("pizza details require authentication while public menu browsing does not", async (t) => {
    const pizza = makePizza({ name: "Details Pizza" });
    const menu = makeCollection([pizza]);
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(CUSTOMER_ID),
                role: "customer",
                blocked: false,
            },
        ]),
        menuItems: menu,
    });
    const auth = makeAuth({
        customer: sessionFor(CUSTOMER_ID, "customer"),
    });

    const app = await startApp((instance) => {
        instance.use("/api/menu", createMenuRoutes(menu, auth, db, makeClient()));
    });
    t.after(app.close);

    let response = await request(app.baseUrl, `/api/menu/${pizza._id}`);
    assert.equal(response.status, 401);

    response = await request(app.baseUrl, "/api/menu");
    assert.equal(response.status, 200);

    response = await request(app.baseUrl, `/api/menu/${pizza._id}`, {
        session: "customer",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "Details Pizza");
});

test("only customers can create orders", async (t) => {
    const pizza = makePizza({ name: "Order Pizza" });
    const orders = makeCollection();
    const db = makeDb({
        user: makeCollection([
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
            {
                _id: new ObjectId(ADMIN_ID),
                role: "admin",
                blocked: false,
            },
        ]),
        menuItems: makeCollection([pizza]),
        orders,
    });
    const auth = makeAuth({
        customer: sessionFor(CUSTOMER_ID, "customer"),
        vendor: sessionFor(VENDOR_ID, "vendor"),
        admin: sessionFor(ADMIN_ID, "admin"),
    });

    const app = await startApp((instance) => {
        instance.use("/api/orders", createOrderRoutes(db, auth));
    });
    t.after(app.close);

    const body = {
        pizzaId: pizza._id.toString(),
        quantity: 1,
        deliveryAddress: "123 Test Street",
        deliveryDate: new Date(Date.now() + 86_400_000).toISOString(),
    };

    for (const role of ["vendor", "admin"]) {
        const response = await request(app.baseUrl, "/api/orders", {
            method: "POST",
            session: role,
            body,
        });

        assert.equal(response.status, 403, `${role} must not place orders`);
    }

    const response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body,
    });

    assert.equal(response.status, 201);
    assert.equal(orders.docs.length, 1);
});

test("Stripe checkout return URLs use the payment result pages", () => {
    assert.deepEqual(buildCheckoutUrls("https://client.example/"), {
        success_url: "https://client.example/payment/success",
        cancel_url: "https://client.example/payment/cancel",
    });

    assert.deepEqual(buildCheckoutUrls(undefined), {
        success_url: "http://localhost:3000/payment/success",
        cancel_url: "http://localhost:3000/payment/cancel",
    });
});

test("admin stats count visible featured pizzas and full transaction totals", async (t) => {
    const menu = makeCollection([
        makePizza({ name: "Visible Featured", isFeatured: true }),
        makePizza({
            name: "Admin Hidden Featured",
            isFeatured: true,
            adminPublished: false,
        }),
        makePizza({
            name: "Deleted Featured",
            isFeatured: true,
            isDeleted: true,
        }),
        makePizza({
            name: "Inactive Featured",
            isFeatured: true,
            isActive: false,
        }),
        makePizza({
            name: "Pending Featured",
            isFeatured: true,
            status: "pending",
        }),
    ]);
    const transactions = makeCollection();
    transactions.aggregate = () => ({
        toArray: async () => [
            { total: 3, successful: 2, completedAmount: 15 },
        ],
    });
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(ADMIN_ID),
                role: "admin",
                blocked: false,
            },
        ]),
        menuItems: menu,
        orders: makeCollection(),
        transactions,
    });
    const app = await startApp((instance) => {
        instance.use(
            "/api/admin",
            createAdminRoutes(
                db,
                makeAuth({ admin: sessionFor(ADMIN_ID, "admin") }),
                makeClient()
            )
        );
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/admin/stats", {
        session: "admin",
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.pizzas.featured, 1);
    assert.deepEqual(body.transactions, {
        total: 3,
        successful: 2,
        completedAmount: 15,
    });
});

test("sign-up password rule is enforced before Better Auth receives the request", async (t) => {
    assert.equal(validatePasswordStrength("Strong1").ok, true);

    for (const weak of ["short", "alllowercase", "ALLUPPER", "123456"]) {
        const result = validatePasswordStrength(weak);
        assert.equal(result.ok, false, `accepted ${weak}`);
        assert.equal(result.message, PASSWORD_RULE_MESSAGE);
    }

    const app = express();
    app.post(
        "/signup",
        readSignupBody,
        requireStrongSignupPassword,
        (req, res) => res.status(200).json({ ok: true, email: req.body.email })
    );

    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    t.after(
        () =>
            new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            )
    );

    let response = await request(baseUrl, "/signup", {
        method: "POST",
        body: { email: "user@example.test", password: "weakpass" },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, PASSWORD_RULE_MESSAGE);

    response = await request(baseUrl, "/signup", {
        method: "POST",
        body: { email: "user@example.test", password: "Strong1" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).email, "user@example.test");
});

test("menu image normalization supports a gallery while keeping the legacy thumbnail", () => {
    const result = normalizeMenuImages({
        image: "https://example.test/first.png",
        images: [
            "https://example.test/second.png",
            "https://example.test/first.png",
            "",
        ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.images, [
        "https://example.test/second.png",
        "https://example.test/first.png",
    ]);

    const legacy = withMenuImages({
        image: "https://example.test/legacy.png",
        _id: "pizza-1",
    });
    assert.deepEqual(legacy.images, ["https://example.test/legacy.png"]);
    assert.equal(legacy.image, "https://example.test/legacy.png");

    assert.equal(normalizeMenuImages({}).ok, false);
    assert.equal(
        normalizeMenuImages({ image: "javascript:alert(1)" }).ok,
        false
    );
    assert.equal(
        normalizeMenuImages({
            images: Array.from(
                { length: 6 },
                (_, index) => `https://example.test/${index}.png`
            ),
        }).ok,
        false
    );

    const indexNames = INDEX_DEFINITIONS.map((definition) => definition.name);
    assert.ok(indexNames.includes("orders_unique_active_customer_pizza_date"));
    assert.ok(!indexNames.includes("orders_unique_active_pending_customer_pizza_date"));
    assert.ok(!indexNames.includes("orders_unique_active_accepted_customer_pizza_date"));
    assert.ok(!indexNames.includes("orders_unique_pending_customer_pizza"));
});

test("order rules persist instructions and block duplicates by pizza and delivery date", async (t) => {
    assert.deepEqual(ACTIVE_ORDER_STATUSES, ["pending", "accepted", "preparing", "out_for_delivery"]);
    assert.equal(
        getDeliveryDateKey("2027-01-01T12:00:00.000Z"),
        "2027-01-01"
    );
    assert.equal(
        getDeliveryDateKey("2027-01-01T12:00:00.000Z", "bad-key"),
        "2027-01-01"
    );
    assert.deepEqual(normalizeOrderMessage("  Extra sauce  "), {
        ok: true,
        value: "Extra sauce",
    });
    assert.equal(normalizeOrderMessage("x".repeat(501)).ok, false);

    const pizzaObjectId = new ObjectId();
    const menu = makeCollection([
        makePizza({
            _id: pizzaObjectId,
            vendorId: VENDOR_ID,
            status: "approved",
            isActive: true,
        }),
    ]);
    const orders = makeCollection();
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(CUSTOMER_ID),
                role: "customer",
                blocked: false,
                name: "Customer",
                email: "customer@example.test",
            },
        ]),
        menuItems: menu,
        orders,
        transactions: makeCollection(),
    });
    const auth = makeAuth({ customer: sessionFor(CUSTOMER_ID, "customer") });
    const app = await startApp((instance) => {
        instance.use("/api/orders", createOrderRoutes(db, auth));
    });
    t.after(app.close);

    const firstBody = {
        pizzaId: pizzaObjectId.toHexString(),
        quantity: 1,
        deliveryAddress: "12 Test Road",
        deliveryDate: "2027-01-01T12:00:00.000Z",
        deliveryDateKey: "2027-01-01",
        message: "  Extra sauce  ",
    };

    let response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body: firstBody,
    });
    assert.equal(response.status, 201);

    const created = orders.docs[0];
    assert.equal(created.message, "Extra sauce");
    assert.equal(created.deliveryDateKey, "2027-01-01");

    response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body: firstBody,
    });
    assert.equal(response.status, 409);

    response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body: {
            ...firstBody,
            deliveryDate: "2027-01-02T12:00:00.000Z",
            deliveryDateKey: "2027-01-02",
        },
    });
    assert.equal(response.status, 201, "a different date must be allowed");

    orders.docs.push({
        customerId: CUSTOMER_ID,
        pizzaId: pizzaObjectId.toHexString(),
        deliveryDateKey: "2027-01-03",
        status: "accepted",
    });

    response = await request(app.baseUrl, "/api/orders", {
        method: "POST",
        session: "customer",
        body: {
            ...firstBody,
            deliveryDate: "2027-01-03T12:00:00.000Z",
            deliveryDateKey: "2027-01-03",
        },
    });
    assert.equal(response.status, 409, "accepted is also an active status");
});

test("admin menu filters and published-status transitions are validated server-side", async (t) => {
    const pendingId = new ObjectId();
    const approvedId = new ObjectId();
    const rejectedId = new ObjectId();
    const inactiveId = new ObjectId();

    const menu = makeCollection([
        makePizza({
            _id: pendingId,
            name: "Pepperoni Pending",
            status: "pending",
            isActive: false,
            price: 8,
            location: "Dhanmondi",
        }),
        makePizza({
            _id: approvedId,
            name: "Pepperoni Approved",
            status: "approved",
            isActive: true,
            adminPublished: true,
            price: 12,
            location: "Dhanmondi",
        }),
        makePizza({
            _id: rejectedId,
            name: "Rejected Cheese",
            status: "rejected",
            isActive: false,
            price: 10,
            location: "Gulshan",
        }),
        makePizza({
            _id: inactiveId,
            name: "Inactive Cheese",
            status: "inactive",
            isActive: true,
            price: 14,
            location: "Gulshan",
        }),
    ]);
    const users = makeCollection([
        {
            _id: new ObjectId(ADMIN_ID),
            role: "admin",
            blocked: false,
        },
        {
            _id: new ObjectId(VENDOR_ID),
            role: "vendor",
            plan: "premium",
            blocked: false,
        },
    ]);
    const db = makeDb({
        user: users,
        menuItems: menu,
        orders: makeCollection(),
        transactions: makeCollection(),
    });
    const app = await startApp((instance) => {
        instance.use(
            "/api/admin",
            createAdminRoutes(
                db,
                makeAuth({ admin: sessionFor(ADMIN_ID, "admin") }),
                makeClient()
            )
        );
    });
    t.after(app.close);

    let response = await request(
        app.baseUrl,
        "/api/admin/menu?search=pepperoni&status=approved&category=Pizza&location=dhan&sort=price_asc",
        { session: "admin" }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
        (await response.json()).map((item) => item._id.toString()),
        [approvedId.toHexString()]
    );

    response = await request(app.baseUrl, "/api/admin/menu?status=rejected", {
        session: "admin",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
        (await response.json()).map((item) => item._id.toString()),
        [rejectedId.toHexString()]
    );

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${pendingId}/status`,
        { method: "PATCH", session: "admin", body: { status: "inactive" } }
    );
    assert.equal(response.status, 409, "pending cannot jump to inactive");

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${pendingId}/status`,
        { method: "PATCH", session: "admin", body: { status: "approved" } }
    );
    assert.equal(response.status, 200);
    assert.equal(menu.docs.find((item) => item._id.equals(pendingId)).status, "approved");

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${approvedId}/status`,
        { method: "PATCH", session: "admin", body: { status: "inactive" } }
    );
    assert.equal(response.status, 200);
    assert.equal(
        menu.docs.find((item) => item._id.equals(approvedId)).adminPublished,
        false
    );

    response = await request(
        app.baseUrl,
        `/api/admin/menu/${inactiveId}/status`,
        { method: "PATCH", session: "admin", body: { status: "approved" } }
    );
    assert.equal(response.status, 200);
    assert.equal(menu.docs.find((item) => item._id.equals(inactiveId)).status, "approved");
});

test("admin transactions expose mapped vendor, plan, amount, status and date", async (t) => {
    const newerDate = new Date("2027-02-02T10:00:00.000Z");
    const transactions = makeCollection([
        {
            _id: new ObjectId(),
            userId: VENDOR_ID,
            type: "premium_subscription",
            status: "succeeded",
            amountTotal: 15,
            currency: "usd",
            createdAt: new Date("2027-01-01T10:00:00.000Z"),
        },
        {
            _id: new ObjectId(),
            vendorId: OTHER_VENDOR_ID,
            plan: "premium",
            paymentStatus: "paid",
            amount: 20,
            currency: "usd",
            updatedAt: newerDate,
        },
    ]);
    const db = makeDb({
        user: makeCollection([
            {
                _id: new ObjectId(ADMIN_ID),
                role: "admin",
                blocked: false,
            },
            {
                _id: new ObjectId(VENDOR_ID),
                name: "Legacy Vendor",
                role: "vendor",
                blocked: false,
            },
            {
                _id: new ObjectId(OTHER_VENDOR_ID),
                businessName: "New Vendor",
                role: "vendor",
                blocked: false,
            },
        ]),
        menuItems: makeCollection(),
        orders: makeCollection(),
        transactions,
    });
    const app = await startApp((instance) => {
        instance.use(
            "/api/admin",
            createAdminRoutes(
                db,
                makeAuth({ admin: sessionFor(ADMIN_ID, "admin") }),
                makeClient()
            )
        );
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/admin/transactions", {
        session: "admin",
    });
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.length, 2);

    const legacy = body.find(
        (item) => String(item._id) === transactions.docs[0]._id.toString()
    );
    assert.equal(String(legacy.vendorId), VENDOR_ID);
    assert.equal(legacy.vendor.name, "Legacy Vendor");
    assert.equal(legacy.plan, "premium");
    assert.equal(legacy.amount, 15);
    assert.equal(legacy.status, "succeeded");
    assert.ok(legacy.createdAt);

    const current = body.find(
        (item) => String(item._id) === transactions.docs[1]._id.toString()
    );
    assert.equal(current.vendor.businessName, "New Vendor");
    assert.equal(current.plan, "premium");
    assert.equal(current.amount, 20);
    assert.equal(current.status, "paid");
    assert.equal(new Date(current.createdAt).getTime(), newerDate.getTime());
});

test("unknown API routes return a JSON 404", async (t) => {
    const app = await startApp((instance) => {
        instance.use("/api", apiNotFound);
    });
    t.after(app.close);

    const response = await request(app.baseUrl, "/api/does-not-exist");

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { message: "API route not found" });
});
