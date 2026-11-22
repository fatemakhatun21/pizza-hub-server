import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";
import { fromNodeHeaders } from "better-auth/node";

export default function createBillingRoutes(db, auth) {
    const router = Router();

    const usersCollection = db.collection("user");
    const transactionsCollection = db.collection("transactions");

    const toId = (value) => {
        if (typeof value === "string") {
            return value;
        }

        return value?.id || null;
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

            const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
            const clientUrl = (
                process.env.CLIENT_URL || "http://localhost:3000"
            ).replace(/\/$/, "");

            const session = await stripe.checkout.sessions.create({
                mode: "subscription",
                line_items: [
                    {
                        price: process.env.STRIPE_PREMIUM_PRICE_ID,
                        quantity: 1,
                    },
                ],
                success_url: `${clientUrl}/vendor/dashboard?checkout=success`,
                cancel_url: `${clientUrl}/vendor/dashboard?checkout=cancelled`,
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

    const handleCheckoutCompleted = async (session) => {
        const userId = session.metadata?.userId || session.client_reference_id;
        const email =
            session.metadata?.email ||
            session.customer_details?.email ||
            "";

        if (userId && ObjectId.isValid(userId)) {
            await usersCollection.updateOne(
                {
                    _id: new ObjectId(userId),
                },
                {
                    $set: {
                        plan: "premium",
                        updatedAt: new Date(),
                    },
                }
            );
        }

        const amountMinor = session.amount_total ?? 0;
        const amountMajor = Number((amountMinor / 100).toFixed(2));

        await transactionsCollection.updateOne(
            {
                stripeSessionId: session.id,
            },
            {
                $set: {
                    stripeSessionId: session.id,
                    stripeSubscriptionId: toId(session.subscription),
                    stripeCustomerId: toId(session.customer),
                    amountTotal: amountMajor,
                    amountTotalMinor: amountMinor,
                    currency: session.currency || "",
                    status: "succeeded",
                    type: "premium_subscription",
                    userId: userId || null,
                    email,
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );
    };

    const handleSubscriptionDeleted = async (event, subscription) => {
        const subscriptionId = subscription.id;
        let userId = subscription.metadata?.userId;

        if (!userId && subscriptionId) {
            const transaction = await transactionsCollection.findOne({
                stripeSubscriptionId: subscriptionId,
            });

            userId = transaction?.userId;
        }

        if (!userId && subscription.customer) {
            const transaction = await transactionsCollection.findOne({
                stripeCustomerId: toId(subscription.customer),
            });

            userId = transaction?.userId;
        }

        if (!userId && subscription.customer_email) {
            const user = await usersCollection.findOne({
                email: String(subscription.customer_email).toLowerCase(),
            });

            userId = user?._id?.toString();
        }

        if (userId && ObjectId.isValid(userId)) {
            await usersCollection.updateOne(
                {
                    _id: new ObjectId(userId),
                },
                {
                    $set: {
                        plan: "free",
                        updatedAt: new Date(),
                    },
                }
            );
        }

        await transactionsCollection.updateOne(
            {
                stripeEventId: event.id,
            },
            {
                $set: {
                    stripeEventId: event.id,
                    stripeSubscriptionId: subscriptionId || null,
                    stripeCustomerId: toId(subscription.customer),
                    status: "succeeded",
                    type: "subscription_cancelled",
                    userId: userId || null,
                    email: subscription.customer_email || "",
                },
                $setOnInsert: {
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );
    };

    const webhook = async (req, res) => {
        const signature = req.headers["stripe-signature"];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret || !signature) {
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

        try {
            if (event.type === "checkout.session.completed") {
                await handleCheckoutCompleted(event.data.object);
            } else if (event.type === "customer.subscription.deleted") {
                await handleSubscriptionDeleted(event, event.data.object);
            }
        } catch (error) {
            console.error("Stripe webhook processing error:", error.message);
        }

        return res.status(200).json({ received: true });
    };

    return { router, webhook };
}
