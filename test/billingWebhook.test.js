import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ObjectId } from "mongodb";

import createBillingRoutes from "../routes/billingRoutes.js";

const WEBHOOK_SECRET = "whsec_pizzahub_unit_test";

const sameValue = (actual, expected) => {
    if (actual instanceof ObjectId || expected instanceof ObjectId) {
        return String(actual) === String(expected);
    }

    return actual === expected;
};

const matchesValue = (actual, expected) => {
    if (
        expected &&
        typeof expected === "object" &&
        !(expected instanceof ObjectId) &&
        Object.keys(expected).some((key) => key.startsWith("$"))
    ) {
        if ("$exists" in expected) {
            return (actual !== undefined) === expected.$exists;
        }

        if ("$ne" in expected) {
            return !sameValue(actual, expected.$ne);
        }

        if ("$lt" in expected) {
            return actual < expected.$lt;
        }

        if ("$in" in expected) {
            return expected.$in.some((value) => sameValue(actual, value));
        }

        return false;
    }

    return sameValue(actual, expected);
};

const matches = (doc, query = {}) =>
    Object.entries(query).every(([field, expected]) => {
        if (field === "$or") {
            return expected.some((subQuery) => matches(doc, subQuery));
        }

        return matchesValue(doc?.[field], expected);
    });

const duplicateError = (keyPattern) =>
    Object.assign(new Error("E11000 duplicate key error"), {
        code: 11000,
        keyPattern,
    });

const makeCollection = (initialDocs = []) => {
    const docs = [...initialDocs];

    const applyUpdate = (doc, update = {}) => {
        for (const [field, value] of Object.entries(update.$set ?? {})) {
            doc[field] = value;
        }

        for (const [field, value] of Object.entries(update.$setOnInsert ?? {})) {
            if (!Object.prototype.hasOwnProperty.call(doc, field)) {
                doc[field] = value;
            }
        }

        for (const [field, value] of Object.entries(update.$inc ?? {})) {
            doc[field] = (doc[field] ?? 0) + value;
        }
    };

    return {
        docs,

        findOne: async (filter) =>
            docs.find((doc) => matches(doc, filter)) ?? null,

        insertOne: async (doc) => {
            if (docs.some((existing) => sameValue(existing._id, doc._id))) {
                throw duplicateError({ _id: 1 });
            }

            docs.push({ ...doc });

            return { insertedId: doc._id };
        },

        updateOne: async (filter, update, options = {}) => {
            const doc = docs.find((item) => matches(item, filter));

            if (!doc && options.upsert) {
                const inserted = {};
                applyUpdate(inserted, update);
                inserted._id = inserted._id ?? new ObjectId();
                docs.push(inserted);

                return {
                    matchedCount: 0,
                    modifiedCount: 0,
                    upsertedCount: 1,
                };
            }

            if (!doc) {
                return { matchedCount: 0, modifiedCount: 0 };
            }

            applyUpdate(doc, update);

            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
};

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(value) {
        this.body = value;
        return this;
    },
});

const signedRequest = (event, secret = WEBHOOK_SECRET) => {
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
        .update(`${timestamp}.${payload}`)
        .digest("hex");

    return {
        body: Buffer.from(payload),
        headers: {
            "stripe-signature": `t=${timestamp},v1=${signature}`,
        },
    };
};

const withWebhookSecret = async (t, run) => {
    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

    t.after(() => {
        if (previous === undefined) {
            delete process.env.STRIPE_WEBHOOK_SECRET;
        } else {
            process.env.STRIPE_WEBHOOK_SECRET = previous;
        }
    });

    return run();
};

const checkoutEvent = (userId, overrides = {}, eventOverrides = {}) => ({
    id: "evt_checkout_1",
    object: "event",
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    ...eventOverrides,
    data: {
        object: {
            id: "cs_test_1",
            object: "checkout.session",
            mode: "subscription",
            client_reference_id: userId,
            metadata: { userId, email: "vendor@example.test" },
            customer: "cus_test_1",
            subscription: "sub_test_1",
            customer_details: { email: "vendor@example.test" },
            amount_total: 1000,
            currency: "usd",
            ...overrides,
        },
    },
});

const subscriptionEvent = ({
    id,
    type = "customer.subscription.updated",
    userId,
    subscriptionId,
    status = "active",
    currentPeriodEnd,
    created = Math.floor(Date.now() / 1000),
}) => ({
    id,
    object: "event",
    type,
    created,
    data: {
        object: {
            id: subscriptionId,
            object: "subscription",
            status,
            metadata: { userId, email: "vendor@example.test" },
            customer: "cus_test_1",
            customer_email: "vendor@example.test",
            current_period_end: currentPeriodEnd,
        },
    },
});

const makeBilling = (collections, options = {}) => {
    const db = {
        collection: (name) =>
            collections[name] ?? makeCollection(),
    };

    return createBillingRoutes(
        db,
        {
            api: { getSession: async () => null },
        },
        options
    );
};

test("duplicate checkout events are acknowledged once and do not re-upgrade the user", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const user = {
            _id: new ObjectId(userId),
            plan: "free",
            role: "vendor",
            email: "vendor@example.test",
        };
        let premiumStateUpdates = 0;

        const userCollection = makeCollection([user]);
        const originalUpdate = userCollection.updateOne.bind(userCollection);
        userCollection.updateOne = async (filter, update, options) => {
            if (update?.$set?.plan) {
                premiumStateUpdates += 1;
            }

            return originalUpdate(filter, update, options);
        };

        const { webhook } = makeBilling({
            user: userCollection,
            transactions: makeCollection(),
            stripeEvents: makeCollection(),
        });

        const event = checkoutEvent(userId);
        const firstResponse = makeResponse();
        await webhook(signedRequest(event), firstResponse);

        assert.equal(firstResponse.statusCode, 200);
        assert.equal(user.plan, "premium");
        assert.equal(user.stripeSubscriptionId, "sub_test_1");
        assert.equal(premiumStateUpdates, 1);

        const secondResponse = makeResponse();
        await webhook(signedRequest(event), secondResponse);

        assert.equal(secondResponse.statusCode, 200);
        assert.equal(secondResponse.body.duplicate, true);
        assert.equal(
            premiumStateUpdates,
            1,
            "duplicate delivery must be a no-op"
        );
    });
});

test("webhook processing failure returns 500 so Stripe retries, then succeeds", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const user = {
            _id: new ObjectId(userId),
            plan: "premium",
            stripeSubscriptionId: "sub_retry_1",
            email: "vendor@example.test",
        };
        let shouldFail = true;

        const userCollection = makeCollection([user]);
        const originalUpdate = userCollection.updateOne.bind(userCollection);
        userCollection.updateOne = async (...args) => {
            if (shouldFail) {
                throw new Error("temporary database failure");
            }

            return originalUpdate(...args);
        };

        const events = makeCollection();
        const { webhook } = makeBilling({
            user: userCollection,
            transactions: makeCollection(),
            stripeEvents: events,
        });

        const event = subscriptionEvent({
            id: "evt_retry_1",
            userId,
            subscriptionId: "sub_retry_1",
            status: "canceled",
            currentPeriodEnd: Math.floor(Date.now() / 1000) - 60,
        });

        const firstResponse = makeResponse();
        await webhook(signedRequest(event), firstResponse);

        assert.equal(firstResponse.statusCode, 500);
        assert.equal(events.docs[0].status, "failed");
        assert.equal(user.plan, "premium");

        shouldFail = false;

        const secondResponse = makeResponse();
        await webhook(signedRequest(event), secondResponse);

        assert.equal(secondResponse.statusCode, 200);
        assert.equal(events.docs[0].status, "processed");
        assert.equal(user.plan, "free");
        assert.equal(events.docs.length, 1);
    });
});

test("expired and stale subscription events respect the current subscription and expiry", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const user = {
            _id: new ObjectId(userId),
            plan: "premium",
            stripeSubscriptionId: "sub_current",
            email: "vendor@example.test",
        };
        const past = Math.floor(Date.now() / 1000) - 3600;

        const { webhook } = makeBilling({
            user: makeCollection([user]),
            transactions: makeCollection(),
            stripeEvents: makeCollection(),
        });

        const staleResponse = makeResponse();
        await webhook(
            signedRequest(
                subscriptionEvent({
                    id: "evt_stale_cancel",
                    userId,
                    subscriptionId: "sub_old",
                    status: "canceled",
                    currentPeriodEnd: past,
                })
            ),
            staleResponse
        );

        assert.equal(staleResponse.statusCode, 200);
        assert.equal(
            user.plan,
            "premium",
            "a stale cancellation must not downgrade a newer subscription"
        );

        const expiryResponse = makeResponse();
        await webhook(
            signedRequest(
                subscriptionEvent({
                    id: "evt_current_expired",
                    userId,
                    subscriptionId: "sub_current",
                    status: "canceled",
                    currentPeriodEnd: past,
                })
            ),
            expiryResponse
        );

        assert.equal(expiryResponse.statusCode, 200);
        assert.equal(user.plan, "free");
        assert.ok(user.premiumExpiresAt);
        assert.equal(user.stripeSubscriptionId, "sub_current");
        assert.equal(user.billingStatus, "canceled");
        assert.equal(user.canceledSubscriptionId, "sub_current");
    });
});

test("invalid signatures, missing configuration, and in-progress events use safe retry codes", async (t) => {
    await withWebhookSecret(t, async () => {
        const { webhook } = makeBilling({});

        const invalid = makeResponse();
        await webhook(
            {
                body: Buffer.from(JSON.stringify({ id: "evt_bad" })),
                headers: { "stripe-signature": "t=1,v1=deadbeef" },
            },
            invalid
        );
        assert.equal(invalid.statusCode, 400);

        const inProgress = makeCollection([
            {
                _id: "evt_in_progress",
                status: "processing",
                updatedAt: new Date(),
            },
        ]);
        const { webhook: withLedger } = makeBilling({
            stripeEvents: inProgress,
        });

        const event = subscriptionEvent({
            id: "evt_in_progress",
            userId: new ObjectId().toHexString(),
            subscriptionId: "sub_in_progress",
        });

        const conflict = makeResponse();
        await withLedger(signedRequest(event), conflict);
        assert.equal(conflict.statusCode, 409);
    });

    const previous = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;

    try {
        const { webhook } = makeBilling({});
        const response = makeResponse();
        await webhook(
            {
                body: Buffer.from("{}"),
                headers: { "stripe-signature": "t=1,v1=deadbeef" },
            },
            response
        );

        assert.equal(response.statusCode, 503);
    } finally {
        if (previous !== undefined) {
            process.env.STRIPE_WEBHOOK_SECRET = previous;
        }
    }
});

test("a delayed checkout after cancellation cannot restore premium", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const user = {
            _id: new ObjectId(userId),
            plan: "free",
            stripeSubscriptionId: null,
            email: "vendor@example.test",
        };
        const transactions = makeCollection([
            {
                _id: new ObjectId(),
                stripeEventId: "evt_legacy_cancel",
                type: "subscription_cancelled",
                stripeSubscriptionId: "sub_old",
                userId,
                status: "succeeded",
            },
        ]);
        const { webhook } = makeBilling({
            user: makeCollection([user]),
            transactions,
            stripeEvents: makeCollection(),
        });

        const event = checkoutEvent(
            userId,
            { subscription: "sub_old" },
            { id: "evt_checkout_delayed" }
        );

        const first = makeResponse();
        await webhook(signedRequest(event), first);

        assert.equal(first.statusCode, 200);
        assert.equal(user.plan, "free", "legacy cancellation must remain in force");
        assert.equal(user.stripeSubscriptionId, null);

        const duplicate = makeResponse();
        await webhook(signedRequest(event), duplicate);

        assert.equal(duplicate.statusCode, 200);
        assert.equal(duplicate.body.duplicate, true);
        assert.equal(user.plan, "free");
    });
});

test("a late active subscription update cannot reactivate a cancelled subscription", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const nowSeconds = Math.floor(Date.now() / 1000);
        const user = {
            _id: new ObjectId(userId),
            plan: "free",
            stripeSubscriptionId: "sub_old",
            billingStatus: "canceled",
            canceledSubscriptionId: "sub_old",
            billingVersion: 1,
            billingEventCreated: nowSeconds - 60,
            email: "vendor@example.test",
        };
        const transactions = makeCollection([
            {
                _id: new ObjectId(),
                stripeEventId: "evt_cancel_old",
                type: "subscription_cancelled",
                stripeSubscriptionId: "sub_old",
                userId,
                status: "succeeded",
            },
        ]);
        const { webhook } = makeBilling({
            user: makeCollection([user]),
            transactions,
            stripeEvents: makeCollection(),
        });

        const response = makeResponse();
        await webhook(
            signedRequest(
                subscriptionEvent({
                    id: "evt_late_active",
                    userId,
                    subscriptionId: "sub_old",
                    status: "active",
                    currentPeriodEnd: nowSeconds + 86_400,
                    created: nowSeconds,
                })
            ),
            response
        );

        assert.equal(response.statusCode, 200);
        assert.equal(user.plan, "free");
        assert.equal(user.billingStatus, "canceled");
    });
});

test("past_due keeps premium through current_period_end and failed payments are recorded", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const futureSeconds = Math.floor(Date.now() / 1000) + 86_400;
        const user = {
            _id: new ObjectId(userId),
            plan: "premium",
            stripeSubscriptionId: "sub_due",
            email: "vendor@example.test",
        };
        const transactions = makeCollection();
        const { webhook } = makeBilling({
            user: makeCollection([user]),
            transactions,
            stripeEvents: makeCollection(),
        });

        let response = makeResponse();
        await webhook(
            signedRequest(
                subscriptionEvent({
                    id: "evt_past_due",
                    userId,
                    subscriptionId: "sub_due",
                    status: "past_due",
                    currentPeriodEnd: futureSeconds,
                })
            ),
            response
        );

        assert.equal(response.statusCode, 200);
        assert.equal(user.plan, "premium");
        assert.equal(user.billingStatus, "past_due");
        assert.equal(
            user.premiumExpiresAt,
            new Date(futureSeconds * 1000).toISOString()
        );

        response = makeResponse();
        await webhook(
            signedRequest({
                id: "evt_invoice_failed",
                object: "event",
                type: "invoice.payment_failed",
                created: Math.floor(Date.now() / 1000),
                data: {
                    object: {
                        id: "in_test_failed",
                        object: "invoice",
                        subscription: "sub_due",
                        customer: "cus_due",
                        customer_email: "vendor@example.test",
                        amount_due: 1500,
                        currency: "usd",
                        last_payment_error: { message: "card declined" },
                    },
                },
            }),
            response
        );

        assert.equal(response.statusCode, 200);
        assert.equal(user.plan, "premium", "failed payment must not immediately revoke");
        const failure = transactions.docs.find(
            (doc) => doc.stripeEventId === "evt_invoice_failed"
        );
        assert.ok(failure);
        assert.equal(failure.status, "failed");
        assert.equal(failure.type, "invoice_payment_failed");
    });
});

test("concurrent billing events use version checks so stale cancellations lose", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const nowSeconds = Math.floor(Date.now() / 1000);
        const user = {
            _id: new ObjectId(userId),
            plan: "premium",
            stripeSubscriptionId: "sub_new",
            billingVersion: 0,
            billingEventCreated: nowSeconds - 120,
            email: "vendor@example.test",
        };
        const userCollection = makeCollection([user]);
        const originalFindOne = userCollection.findOne.bind(userCollection);
        let staleReads = 2;

        userCollection.findOne = async (...args) => {
            if (staleReads > 0) {
                staleReads -= 1;
                return { ...user, billingVersion: 0 };
            }

            return originalFindOne(...args);
        };

        const { webhook } = makeBilling({
            user: userCollection,
            transactions: makeCollection(),
            stripeEvents: makeCollection(),
        });

        const staleCancellation = subscriptionEvent({
            id: "evt_concurrent_cancel",
            userId,
            subscriptionId: "sub_old",
            status: "canceled",
            currentPeriodEnd: nowSeconds - 60,
            created: nowSeconds - 60,
        });
        const newSubscription = subscriptionEvent({
            id: "evt_concurrent_new",
            userId,
            subscriptionId: "sub_new",
            status: "active",
            currentPeriodEnd: nowSeconds + 86_400,
            created: nowSeconds,
        });

        const [cancelResponse, newResponse] = await Promise.all([
            webhook(signedRequest(staleCancellation), makeResponse()),
            webhook(signedRequest(newSubscription), makeResponse()),
        ]);

        assert.equal(cancelResponse.statusCode, 200);
        assert.equal(newResponse.statusCode, 200);
        assert.equal(user.plan, "premium");
        assert.equal(user.stripeSubscriptionId, "sub_new");
        assert.notEqual(user.billingStatus, "canceled");
    });
});

test("checkout completion stores Stripe expiry when the subscription can be read", async (t) => {
    await withWebhookSecret(t, async () => {
        const previous = process.env.STRIPE_SECRET_KEY;
        process.env.STRIPE_SECRET_KEY = "sk_test_read_only";

        try {
            const userId = new ObjectId().toHexString();
            const futureSeconds = Math.floor(Date.now() / 1000) + 86_400;
            const user = {
                _id: new ObjectId(userId),
                plan: "free",
                email: "vendor@example.test",
            };
            const { webhook } = makeBilling(
                {
                    user: makeCollection([user]),
                    transactions: makeCollection(),
                    stripeEvents: makeCollection(),
                },
                {
                    stripeFactory: () => ({
                        subscriptions: {
                            retrieve: async () => ({
                                current_period_end: futureSeconds,
                            }),
                        },
                    }),
                }
            );

            const response = makeResponse();
            await webhook(
                signedRequest(
                    checkoutEvent(userId, { subscription: "sub_expiry" })
                ),
                response
            );

            assert.equal(response.statusCode, 200);
            assert.equal(user.plan, "premium");
            assert.equal(
                user.premiumExpiresAt,
                new Date(futureSeconds * 1000).toISOString()
            );
        } finally {
            if (previous === undefined) {
                delete process.env.STRIPE_SECRET_KEY;
            } else {
                process.env.STRIPE_SECRET_KEY = previous;
            }
        }
    });
});

test("a new checkout after cancellation restores premium and stale old events stay rejected", async (t) => {
    await withWebhookSecret(t, async () => {
        const previous = process.env.STRIPE_SECRET_KEY;
        process.env.STRIPE_SECRET_KEY = "sk_test_read_only";

        try {
            const userId = new ObjectId().toHexString();
            const nowSeconds = Math.floor(Date.now() / 1000);
            const futureSeconds = nowSeconds + 86_400;
            const user = {
                _id: new ObjectId(userId),
                plan: "free",
                stripeSubscriptionId: "sub_old",
                billingStatus: "canceled",
                canceledSubscriptionId: "sub_old",
                billingVersion: 1,
                billingEventCreated: nowSeconds - 60,
                email: "vendor@example.test",
            };
            const transactions = makeCollection([
                {
                    _id: new ObjectId(),
                    stripeEventId: "evt_cancel_old",
                    type: "subscription_cancelled",
                    stripeSubscriptionId: "sub_old",
                    userId,
                    status: "succeeded",
                },
            ]);
            const { webhook } = makeBilling(
                {
                    user: makeCollection([user]),
                    transactions,
                    stripeEvents: makeCollection(),
                },
                {
                    stripeFactory: () => ({
                        subscriptions: {
                            retrieve: async () => ({
                                current_period_end: futureSeconds,
                            }),
                        },
                    }),
                }
            );

            const resubscribe = makeResponse();
            await webhook(
                signedRequest(
                    checkoutEvent(
                        userId,
                        { subscription: "sub_new" },
                        {
                            id: "evt_checkout_new",
                            created: nowSeconds,
                        }
                    )
                ),
                resubscribe
            );

            assert.equal(resubscribe.statusCode, 200);
            assert.equal(user.plan, "premium");
            assert.equal(user.stripeSubscriptionId, "sub_new");
            assert.equal(user.billingStatus, "active");
            assert.equal(user.canceledSubscriptionId, null);

            const staleUpdate = makeResponse();
            await webhook(
                signedRequest(
                    subscriptionEvent({
                        id: "evt_late_old_update",
                        userId,
                        subscriptionId: "sub_old",
                        status: "active",
                        currentPeriodEnd: futureSeconds,
                        created: nowSeconds + 1,
                    })
                ),
                staleUpdate
            );

            assert.equal(staleUpdate.statusCode, 200);
            assert.equal(user.plan, "premium");
            assert.equal(user.stripeSubscriptionId, "sub_new");

            const staleCheckout = makeResponse();
            await webhook(
                signedRequest(
                    checkoutEvent(
                        userId,
                        { subscription: "sub_old" },
                        {
                            id: "evt_late_old_checkout",
                            created: nowSeconds + 2,
                        }
                    )
                ),
                staleCheckout
            );

            assert.equal(staleCheckout.statusCode, 200);
            assert.equal(user.plan, "premium");
            assert.equal(user.stripeSubscriptionId, "sub_new");
        } finally {
            if (previous === undefined) {
                delete process.env.STRIPE_SECRET_KEY;
            } else {
                process.env.STRIPE_SECRET_KEY = previous;
            }
        }
    });
});

test("a duplicate Stripe transaction upsert updates the existing ledger row", async (t) => {
    await withWebhookSecret(t, async () => {
        const userId = new ObjectId().toHexString();
        const event = subscriptionEvent({
            id: "evt_transaction_race",
            userId,
            subscriptionId: "sub_race",
            status: "active",
            currentPeriodEnd: Math.floor(Date.now() / 1000) + 86_400,
        });
        const transactions = makeCollection([
            {
                _id: new ObjectId(),
                stripeEventId: event.id,
                status: "failed",
                type: "invoice_payment_failed",
            },
        ]);
        const originalUpdate = transactions.updateOne.bind(transactions);
        let duplicateCalls = 0;

        transactions.updateOne = async (filter, update, options) => {
            if (
                options?.upsert &&
                transactions.docs.some(
                    (doc) => doc.stripeEventId === filter.stripeEventId
                )
            ) {
                duplicateCalls += 1;
                throw duplicateError({ stripeEventId: 1 });
            }

            return originalUpdate(filter, update, options);
        };

        const { webhook } = makeBilling({
            user: makeCollection([
                {
                    _id: new ObjectId(userId),
                    plan: "free",
                    email: "vendor@example.test",
                },
            ]),
            transactions,
            stripeEvents: makeCollection(),
        });

        const response = makeResponse();
        await webhook(signedRequest(event), response);

        assert.equal(response.statusCode, 200);
        assert.equal(duplicateCalls, 1);
        assert.equal(transactions.docs.length, 1);
        assert.equal(transactions.docs[0].status, "succeeded");
        assert.equal(transactions.docs[0].type, "subscription_updated");
    });
});
