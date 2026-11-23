import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { fromNodeHeaders } from "better-auth/node";
import { getPremiumExpiryDate } from "../services/premiumStatus.js";
import { isDuplicateKeyError } from "../utils/mongoErrors.js";

export function buildCheckoutUrls(clientUrl) {
    const baseUrl = String(clientUrl || "http://localhost:3000").replace(
        /\/$/,
        ""
    );

    return {
        success_url: `${baseUrl}/payment/success`,
        cancel_url: `${baseUrl}/payment/cancel`,
    };
}

// past_due is intentionally NOT an ended state. Confirmed policy is grace
// until Stripe's current_period_end; invoice.payment_failed is recorded only.
const INACTIVE_SUBSCRIPTION_STATUSES = new Set([
    "canceled",
    "incomplete",
    "incomplete_expired",
    "unpaid",
]);

const STALE_PROCESSING_MS = 5 * 60 * 1000;
const MAX_BILLING_COMMITS = 3;

export default function createBillingRoutes(db, auth, options = {}) {
    const {
        stripeFactory = (secretKey) => new Stripe(secretKey),
    } = options;

    const router = Router();

    const usersCollection = db.collection("user");
    const transactionsCollection = db.collection("transactions");
    const eventsCollection = db.collection("stripeEvents");

    const toId = (value) => {
        if (typeof value === "string") {
            return value;
        }

        return value?.id || null;
    };

    const toEventCreated = (event) => {
        const value = Number(event?.created);

        return Number.isFinite(value) && value > 0 ? value : 0;
    };

    // Stripe subscription timestamps are Unix seconds. Keep the conversion at
    // the webhook boundary so stored expiry values are real UTC dates.
    const getStripeExpiryDate = (value) => {
        const numericValue = typeof value === "string" ? Number(value) : value;

        if (
            typeof numericValue === "number" &&
            Number.isFinite(numericValue) &&
            Math.abs(numericValue) < 1_000_000_000_000
        ) {
            return getPremiumExpiryDate(numericValue * 1000);
        }

        return getPremiumExpiryDate(value);
    };

    const getBillingUser = async (userId) =>
        usersCollection.findOne(
            { _id: new ObjectId(userId) },
            {
                projection: {
                    plan: 1,
                    isPremium: 1,
                    premiumExpiresAt: 1,
                    stripeSubscriptionId: 1,
                    billingVersion: 1,
                    billingStatus: 1,
                    canceledSubscriptionId: 1,
                    billingEventCreated: 1,
                },
            }
        );

    const normalizeBillingVersion = async (userId) => {
        await usersCollection.updateOne(
            {
                _id: new ObjectId(userId),
                $or: [
                    { billingVersion: { $exists: false } },
                    { billingVersion: null },
                ],
            },
            { $set: { billingVersion: 0 } }
        );
    };

    // Every premium transition is an atomic compare-and-set on billingVersion.
    // Two concurrent Stripe events cannot both win from the same observed state.
    const commitBillingState = async ({
        userId,
        eventCreated = 0,
        decide,
    }) => {
        for (let attempt = 0; attempt < MAX_BILLING_COMMITS; attempt++) {
            await normalizeBillingVersion(userId);

            const current = await getBillingUser(userId);

            if (!current) {
                return { applied: false, current: null };
            }

            const currentCreated = Number(current.billingEventCreated ?? 0);

            if (eventCreated > 0 && currentCreated > eventCreated) {
                return { applied: false, current, skipped: true };
            }

            const decision = decide(current);

            if (!decision?.set) {
                return { applied: false, current, skipped: true };
            }

            const expectedVersion = Number(current.billingVersion ?? 0);
            const nextSet = {
                ...decision.set,
                billingVersion: expectedVersion + 1,
                billingEventCreated: Math.max(currentCreated, eventCreated),
                updatedAt: new Date(),
            };

            const result = await usersCollection.updateOne(
                {
                    _id: new ObjectId(userId),
                    billingVersion: expectedVersion,
                },
                { $set: nextSet }
            );

            if (result.matchedCount || result.modifiedCount) {
                return {
                    applied: true,
                    current: { ...current, ...nextSet },
                };
            }
        }

        return {
            applied: false,
            current: await getBillingUser(userId),
            conflict: true,
        };
    };

    // Legacy cancellation events wrote a transaction but no version marker.
    // This durable record prevents old deliveries from restoring access.
    const hasCancellationRecord = async (userId, subscriptionId) => {
        if (!userId || !subscriptionId) {
            return false;
        }

        const cancellation = await transactionsCollection.findOne({
            userId,
            type: "subscription_cancelled",
            stripeSubscriptionId: subscriptionId,
        });

        return Boolean(cancellation);
    };

    // A checkout is the only event allowed to start a genuinely new
    // subscription after cancellation. It must replace the exact subscription
    // that was canceled; subscription update/delete events never qualify.
    const canActivateReplacementSubscription = (current, subscriptionId) => {
        if (
            !subscriptionId ||
            current.billingStatus !== "canceled" ||
            !current.canceledSubscriptionId ||
            current.canceledSubscriptionId === subscriptionId
        ) {
            return false;
        }

        return (
            !current.stripeSubscriptionId ||
            current.stripeSubscriptionId === current.canceledSubscriptionId
        );
    };

    const requireVendor = async (req, res, next) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });

            if (!session?.user) {
                return res.status(401).json({
                    message: "Please sign in first",
                });
            }

            if (!ObjectId.isValid(session.user.id)) {
                return res.status(401).json({
                    message: "Invalid session",
                });
            }

            const user = await usersCollection.findOne({
                _id: new ObjectId(session.user.id),
            });

            if (!user || user.role !== "vendor" || user.blocked === true) {
                return res.status(403).json({
                    message: "Only active vendors can upgrade to premium",
                });
            }

            req.user = {
                ...user,
                id: session.user.id,
            };

            next();
        } catch (error) {
            console.error("Billing auth error:", error.message);

            res.status(500).json({
                message: "Unable to verify permission",
            });
        }
    };

    router.post("/checkout", requireVendor, async (req, res) => {
        try {
            if (
                !process.env.STRIPE_SECRET_KEY ||
                !process.env.STRIPE_PREMIUM_PRICE_ID
            ) {
                return res.status(503).json({
                    message: "Stripe is not configured",
                });
            }

            const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);

            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                line_items: [
                    {
                        price: process.env.STRIPE_PREMIUM_PRICE_ID,
                        quantity: 1,
                    },
                ],
                ...buildCheckoutUrls(process.env.CLIENT_URL),
                client_reference_id: req.user.id,
                metadata: {
                    userId: req.user.id,
                    email: req.user.email || "",
                },
                subscription_data: {
                    metadata: {
                        userId: req.user.id,
                        email: req.user.email || "",
                    },
                },
            });

            return res.status(200).json({ url: session.url });
        } catch (error) {
            console.error("Stripe checkout error:", error.message);

            return res.status(500).json({
                message: "Failed to create checkout session",
            });
        }
    });

    const recordTransaction = async ({
        eventId,
        sessionId,
        subscriptionId,
        customerId,
        amountMinor = 0,
        currency = "",
        status,
        type,
        userId,
        email,
        premiumExpiresAt = null,
    }) => {
        const amountMajor = Number((amountMinor / 100).toFixed(2));
        const values = {
            stripeEventId: eventId,
            stripeSessionId: sessionId || null,
            stripeSubscriptionId: subscriptionId || null,
            stripeCustomerId: customerId || null,
            amountTotal: amountMajor,
            amountTotalMinor: amountMinor,
            amount: amountMajor,
            currency,
            status,
            type,
            plan: /premium|subscription/i.test(String(type ?? ""))
                ? "premium"
                : "unknown",
            vendorId: userId || null,
            userId: userId || null,
            email: email || "",
            premiumExpiresAt,
            updatedAt: new Date(),
        };

        try {
            await transactionsCollection.updateOne(
                { stripeEventId: eventId },
                {
                    $set: values,
                    $setOnInsert: { createdAt: new Date() },
                },
                { upsert: true }
            );
        } catch (error) {
            // The unique partial index is the real concurrency guard. If two
            // deliveries race, the loser updates the already-inserted row
            // instead of creating a duplicate ledger entry.
            if (!isDuplicateKeyError(error)) {
                throw error;
            }

            await transactionsCollection.updateOne(
                { stripeEventId: eventId },
                { $set: values }
            );
        }
    };

    const resolveCheckoutExpiry = async (subscriptionId) => {
        if (!subscriptionId || !process.env.STRIPE_SECRET_KEY) {
            return null;
        }

        // Read-only Stripe API call. A failure returns 500 from the webhook so
        // Stripe retries instead of granting permanent Premium by default.
        const stripe = stripeFactory(process.env.STRIPE_SECRET_KEY);
        const subscription = await stripe.subscriptions.retrieve(
            subscriptionId
        );

        return getStripeExpiryDate(
            subscription.current_period_end ??
                subscription.ended_at ??
                subscription.canceled_at
        );
    };

    const handleCheckoutCompleted = async (event, session) => {
        const userId = session.metadata?.userId || session.client_reference_id;
        const email =
            session.metadata?.email ||
            session.customer_details?.email ||
            "";
        const subscriptionId = toId(session.subscription);

        if (userId && ObjectId.isValid(userId)) {
            const cancellationRecord = await hasCancellationRecord(
                userId,
                subscriptionId
            );
            const expiryDate = await resolveCheckoutExpiry(subscriptionId);

            const outcome = await commitBillingState({
                userId,
                eventCreated: toEventCreated(event),
                decide: (current) => {
                    // A checkout that belongs to an already-cancelled
                    // subscription must never restore Premium, even when the
                    // cancellation happened before version markers existed.
                    if (cancellationRecord) {
                        return null;
                    }

                    if (
                        current.billingStatus === "canceled" &&
                        current.canceledSubscriptionId === subscriptionId
                    ) {
                        return null;
                    }

                    const replacingCanceledSubscription =
                        canActivateReplacementSubscription(
                            current,
                            subscriptionId
                        );

                    if (
                        current.stripeSubscriptionId &&
                        subscriptionId &&
                        current.stripeSubscriptionId !== subscriptionId &&
                        !replacingCanceledSubscription
                    ) {
                        return null;
                    }

                    return {
                        set: {
                            plan: "premium",
                            stripeSubscriptionId: subscriptionId || null,
                            billingStatus: "active",
                            canceledSubscriptionId: null,
                            ...(expiryDate
                                ? {
                                      premiumExpiresAt:
                                          expiryDate.toISOString(),
                                  }
                                : {}),
                        },
                    };
                },
            });

            if (outcome.conflict) {
                throw new Error(
                    "Billing state changed concurrently; retrying the webhook"
                );
            }
        }

        await recordTransaction({
            eventId: event.id,
            sessionId: session.id,
            subscriptionId,
            customerId: toId(session.customer),
            amountMinor: session.amount_total ?? 0,
            currency: session.currency || "",
            status: "succeeded",
            type: "premium_subscription",
            userId: ObjectId.isValid(userId) ? userId : null,
            email,
        });
    };

    const resolveSubscriptionUserId = async (subscription) => {
        let userId = subscription.metadata?.userId;
        const subscriptionId = subscription.id;
        const customerId = toId(subscription.customer);

        if (!userId && subscriptionId) {
            const transaction = await transactionsCollection.findOne({
                stripeSubscriptionId: subscriptionId,
            });

            userId = transaction?.userId;
        }

        if (!userId && customerId) {
            const transaction = await transactionsCollection.findOne({
                stripeCustomerId: customerId,
            });

            userId = transaction?.userId;
        }

        if (!userId && subscription.customer_email) {
            const user = await usersCollection.findOne({
                email: String(subscription.customer_email).toLowerCase(),
            });

            userId = user?._id?.toString();
        }

        return userId;
    };

    const handleSubscriptionEvent = async (event, subscription) => {
        const subscriptionId = subscription.id;
        const resolvedUserId = await resolveSubscriptionUserId(subscription);
        const userId =
            resolvedUserId && ObjectId.isValid(resolvedUserId)
                ? resolvedUserId
                : null;
        const now = new Date();
        const expiryDate = getStripeExpiryDate(
            subscription.current_period_end ??
                subscription.ended_at ??
                subscription.canceled_at
        );

        const hasEnded =
            event.type === "customer.subscription.deleted" ||
            INACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) ||
            (subscription.ended_at
                ? new Date(subscription.ended_at).getTime() <= now.getTime()
                : false) ||
            Boolean(
                subscription.cancel_at_period_end &&
                    expiryDate &&
                    expiryDate.getTime() <= now.getTime()
            );

        if (!userId) {
            return;
        }

        const cancellationRecord = hasEnded
            ? false
            : await hasCancellationRecord(userId, subscriptionId);

        const outcome = await commitBillingState({
            userId,
            eventCreated: toEventCreated(event),
            decide: (current) => {
                // Never let an older subscription overwrite a newer one.
                if (
                    current.stripeSubscriptionId &&
                    subscriptionId &&
                    current.stripeSubscriptionId !== subscriptionId
                ) {
                    return null;
                }

                if (hasEnded) {
                    if (
                        current.billingStatus === "canceled" &&
                        current.canceledSubscriptionId === subscriptionId
                    ) {
                        return null;
                    }

                    return {
                        set: {
                            plan: "free",
                            stripeSubscriptionId: subscriptionId || null,
                            billingStatus: "canceled",
                            canceledSubscriptionId: subscriptionId || null,
                            premiumExpiresAt: (
                                expiryDate ?? now
                            ).toISOString(),
                        },
                    };
                }

                // A late active update for a cancelled subscription must not
                // recreate Premium.
                if (cancellationRecord) {
                    return null;
                }

                if (
                    current.billingStatus === "canceled" &&
                    current.canceledSubscriptionId === subscriptionId
                ) {
                    return null;
                }

                return {
                    set: {
                        plan: "premium",
                        stripeSubscriptionId: subscriptionId || null,
                        billingStatus:
                            subscription.status === "past_due"
                                ? "past_due"
                                : "active",
                        canceledSubscriptionId: null,
                        ...(expiryDate
                            ? {
                                  premiumExpiresAt: expiryDate.toISOString(),
                              }
                            : {}),
                    },
                };
            },
        });

        if (outcome.conflict) {
            throw new Error(
                "Billing state changed concurrently; retrying the webhook"
            );
        }

        await recordTransaction({
            eventId: event.id,
            subscriptionId,
            customerId: toId(subscription.customer),
            status: "succeeded",
            type: hasEnded ? "subscription_cancelled" : "subscription_updated",
            userId,
            email: subscription.customer_email || "",
            premiumExpiresAt: expiryDate ? expiryDate.toISOString() : null,
        });
    };

    const handleInvoicePaymentFailed = async (event, invoice) => {
        const subscriptionId = toId(invoice.subscription);
        const customerId = toId(invoice.customer);

        let userId = null;

        if (subscriptionId) {
            const transaction = await transactionsCollection.findOne({
                stripeSubscriptionId: subscriptionId,
            });
            userId = transaction?.userId ?? null;
        }

        if (!userId && customerId) {
            const transaction = await transactionsCollection.findOne({
                stripeCustomerId: customerId,
            });
            userId = transaction?.userId ?? null;
        }

        if (!userId && invoice.customer_email) {
            const user = await usersCollection.findOne({
                email: String(invoice.customer_email).toLowerCase(),
            });
            userId = user?._id?.toString() ?? null;
        }

        console.warn(
            `Stripe payment failed [${event.id}/${subscriptionId || customerId}]: ${invoice.last_payment_error?.message || "payment failed"}`
        );

        // Confirmed policy: grace until Stripe current_period_end. Record the
        // failure for audit/debugging; subscription events perform any access
        // change.
        await recordTransaction({
            eventId: event.id,
            sessionId: null,
            subscriptionId,
            customerId,
            amountMinor: invoice.amount_due ?? 0,
            currency: invoice.currency || "",
            status: "failed",
            type: "invoice_payment_failed",
            userId,
            email: invoice.customer_email || "",
        });
    };

    const claimEvent = async (event) => {
        const now = new Date();

        try {
            await eventsCollection.insertOne({
                _id: event.id,
                type: event.type,
                status: "processing",
                createdAt: now,
                updatedAt: now,
                attempts: 1,
            });

            return "claimed";
        } catch (error) {
            if (!isDuplicateKeyError(error)) {
                throw error;
            }

            const existing = await eventsCollection.findOne({
                _id: event.id,
            });

            if (!existing) {
                return "in_progress";
            }

            if (existing.status === "processed") {
                return "duplicate";
            }

            const retryable =
                existing.status === "failed" ||
                (existing.status === "processing" &&
                    new Date(existing.updatedAt ?? 0).getTime() <=
                        Date.now() - STALE_PROCESSING_MS);

            if (!retryable) {
                return "in_progress";
            }

            const result = await eventsCollection.updateOne(
                { _id: event.id },
                {
                    $set: {
                        status: "processing",
                        type: event.type,
                        updatedAt: new Date(),
                    },
                    $inc: { attempts: 1 },
                }
            );

            return result.matchedCount || result.modifiedCount
                ? "claimed"
                : "in_progress";
        }
    };

    const markEvent = async (event, status, extra = {}) => {
        await eventsCollection.updateOne(
            { _id: event.id },
            {
                $set: {
                    status,
                    ...extra,
                    updatedAt: new Date(),
                },
            }
        );
    };

    const webhook = async (req, res) => {
        const signature = req.headers["stripe-signature"];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret) {
            console.error("Stripe webhook secret is not configured");

            return res.status(503).json({
                message: "Webhook is not configured",
            });
        }

        if (!signature) {
            return res.status(400).json({
                message: "Invalid webhook signature",
            });
        }

        let event;

        try {
            event = Stripe.webhooks.constructEvent(
                req.body,
                signature,
                webhookSecret
            );
        } catch (error) {
            console.error("Stripe signature verification error:", error.message);

            return res.status(400).json({
                message: "Invalid webhook signature",
            });
        }

        let claim;

        try {
            claim = await claimEvent(event);
        } catch (error) {
            console.error(
                `Stripe event ledger error [${event.id}/${event.type}]:`,
                error.message
            );

            return res.status(500).json({
                message: "Webhook processing failed",
            });
        }

        if (claim === "duplicate") {
            return res.status(200).json({
                received: true,
                duplicate: true,
            });
        }

        if (claim === "in_progress") {
            return res.status(409).json({
                message: "Webhook event is already being processed",
            });
        }

        try {
            if (event.type === "checkout.session.completed") {
                await handleCheckoutCompleted(event, event.data.object);
            } else if (
                event.type === "customer.subscription.deleted" ||
                event.type === "customer.subscription.updated"
            ) {
                await handleSubscriptionEvent(event, event.data.object);
            } else if (event.type === "invoice.payment_failed") {
                await handleInvoicePaymentFailed(event, event.data.object);
            }

            await markEvent(event, "processed", {
                processedAt: new Date(),
            });

            return res.status(200).json({ received: true });
        } catch (error) {
            console.error(
                `Stripe webhook processing error [${event.id}/${event.type}]:`,
                error.message
            );

            try {
                await markEvent(event, "failed", {
                    failedAt: new Date(),
                    error: error.message,
                });
            } catch (markError) {
                console.error(
                    `Stripe event status update error [${event.id}]:`,
                    markError.message
                );
            }

            // Non-2xx tells Stripe to retry instead of marking delivery done.
            return res.status(500).json({
                message: "Webhook processing failed",
            });
        }
    };

    return { router, webhook };
}
