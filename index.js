import "dotenv/config";
import dns from "node:dns";
import express from "express";
import cors from "cors";
import createUploadRoutes from "./routes/uploadRoutes.js";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";

import createMenuRoutes from "./routes/menuRoutes.js";
import createAdminRoutes from "./routes/adminRoutes.js";
import createOrderRoutes from "./routes/orderRoutes.js";
import createBillingRoutes from "./routes/billingRoutes.js";
import createWishlistRoutes from "./routes/wishlistRoutes.js";
import createReviewRoutes from "./routes/reviewRoutes.js";
import { createAuth, getTrustedOrigins } from "./config/auth.js";
import {
    createJWTVerifier,
    requireJWT,
    withJWTSessions,
} from "./middleware/verifyJWT.js";

const configuredDnsServers = (process.env.DNS_SERVERS || "")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);

if (configuredDnsServers.length > 0) {
    dns.setServers(configuredDnsServers);
} else if (process.env.NODE_ENV !== "production") {
    // Local networks in this course environment cannot resolve MongoDB SRV records.
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

const app = express();
const port = process.env.PORT || 5000;
const trustedOrigins = getTrustedOrigins();

app.use(
    cors({
        origin: trustedOrigins,
        credentials: true,
    })
);

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok" });
});

const uri = process.env.MONGODB_URI;

if (!uri) {
    throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function startServer() {
    try {
        await client.connect();
        await client.db("admin").command({ ping: 1 });

        console.log("MongoDB Connected Successfully!");

        const db = client.db("pizzahub_db");
        const auth = createAuth(db, client);
        const jwtVerifier = createJWTVerifier();
        const protectedAuth = withJWTSessions(auth, db, jwtVerifier);
        const billing = createBillingRoutes(db, protectedAuth);

        app.all("/api/auth/*splat", toNodeHandler(auth));

        // Keep this before express.json so Stripe receives the raw body.
        app.post(
            "/api/billing/webhook",
            express.raw({ type: "application/json" }),
            billing.webhook
        );

        app.use(express.json());

        const verifySession = async (req, res, next) => {
            try {
                const session = await protectedAuth.api.getSession({
                    headers: fromNodeHeaders(req.headers),
                });

                if (!session?.user) {
                    return res.status(401).json({
                        message: "Unauthorized. Please sign in.",
                    });
                }

                if (!ObjectId.isValid(session.user.id)) {
                    return res.status(401).json({
                        message: "Unauthorized. Please sign in.",
                    });
                }

                const user = await db.collection("user").findOne({
                    _id: new ObjectId(session.user.id),
                });

                if (!user || user.blocked === true) {
                    return res.status(403).json({
                        message: "Account unavailable or blocked",
                    });
                }

                req.user = {
                    ...session.user,
                    role: user.role || "customer",
                    plan: user.plan || "free",
                };
                req.dbUser = user;
                req.session = session.session;

                next();
            } catch (error) {
                console.error("Session verification error:", error.message);

                return res.status(500).json({
                    message: "Unable to verify session.",
                });
            }
        };

        const toProfile = (user, sessionUser = {}) => ({
            id: user._id.toString(),
            name: user.name ?? sessionUser.name ?? "",
            email: user.email ?? sessionUser.email ?? "",
            image: user.image ?? sessionUser.image ?? null,
            role: user.role || "customer",
            plan: user.plan || "free",
            isPremium: user.plan === "premium",
        });

        // JWT-only endpoint for API clients. The browser app continues to use
        // the cookie-backed /api/me routes below.
        app.get("/api/jwt/me", requireJWT(jwtVerifier, db), (req, res) => {
            return res.status(200).json({
                user: toProfile(req.dbUser, req.user),
            });
        });

        app.get("/api/me", verifySession, (req, res) => {
            return res.status(200).json({
                user: toProfile(req.dbUser, req.user),
            });
        });

        app.patch("/api/me", verifySession, async (req, res) => {
            try {
                const body = req.body ?? {};
                const allowedKeys = ["name", "image"];

                if (
                    Object.keys(body).some(
                        (key) => !allowedKeys.includes(key)
                    )
                ) {
                    return res.status(400).json({
                        message: "Only name and image can be updated",
                    });
                }

                const { name, image } = body;

                if (typeof name !== "string") {
                    return res.status(400).json({
                        message: "Name must be between 1 and 80 characters",
                    });
                }

                const trimmedName = name.trim();

                if (
                    trimmedName.length < 1 ||
                    trimmedName.length > 80
                ) {
                    return res.status(400).json({
                        message: "Name must be between 1 and 80 characters",
                    });
                }

                if (image !== undefined) {
                    if (typeof image !== "string") {
                        return res.status(400).json({
                            message: "Image must be a URL or an empty string",
                        });
                    }

                    if (image !== "") {
                        let imageUrl;

                        try {
                            imageUrl = new URL(image);
                        } catch {
                            return res.status(400).json({
                                message:
                                    "Image must be a valid http or https URL",
                            });
                        }

                        if (
                            !["http:", "https:"].includes(imageUrl.protocol)
                        ) {
                            return res.status(400).json({
                                message:
                                    "Image must be a valid http or https URL",
                            });
                        }
                    }
                }

                const updates = {
                    name: trimmedName,
                    updatedAt: new Date(),
                };

                if (image !== undefined) {
                    updates.image = image;
                }

                const result = await db.collection("user").updateOne(
                    {
                        _id: new ObjectId(req.user.id),
                        blocked: { $ne: true },
                    },
                    {
                        $set: updates,
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(403).json({
                        message: "Account unavailable or blocked",
                    });
                }

                const user = await db.collection("user").findOne({
                    _id: new ObjectId(req.user.id),
                });

                return res.status(200).json({
                    message: "Profile updated successfully",
                    user: toProfile(user, req.user),
                });
            } catch (error) {
                console.error("Profile update error:", error.message);

                return res.status(500).json({
                    message: "Failed to update profile",
                });
            }
        });

        app.post("/api/vendor/register", verifySession, async (req, res) => {
            try {
                const usersCollection = db.collection("user");

                if (!ObjectId.isValid(req.user.id)) {
                    return res.status(400).json({
                        message: "Invalid user ID",
                    });
                }

                const result = await usersCollection.updateOne(
                    {
                        _id: new ObjectId(req.user.id),
                        role: "customer",
                        blocked: { $ne: true },
                    },
                    {
                        $set: {
                            role: "vendor",
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(403).json({
                        message: "Only customers can register as vendors",
                    });
                }

                res.status(200).json({
                    message: "Vendor registration successful",
                    role: "vendor",
                });
            } catch (error) {
                console.error("Vendor registration error:", error.message);

                res.status(500).json({
                    message: "Failed to register vendor",
                });
            }
        });

        const menuCollection = db.collection("menuItems");

        app.use("/api/uploads", createUploadRoutes(db, protectedAuth));
        app.use("/api/menu", createMenuRoutes(menuCollection, protectedAuth, db));
        app.use("/api/admin", createAdminRoutes(db, protectedAuth));
        app.use("/api/orders", createOrderRoutes(db, protectedAuth));
        app.use("/api/wishlist", createWishlistRoutes(db, protectedAuth));
        app.use("/api/reviews", createReviewRoutes(db, protectedAuth));
        app.use("/api/billing", billing.router);

        app.get("/", (req, res) => {
            res.send("PizzaHub Server is Running!");
        });

        app.listen(port, () => {
            console.log(`PizzaHub Server running on port ${port}`);
        });
    } catch (error) {
        console.error("MongoDB Connection Failed:", error.message);
        process.exit(1);
    }
}

startServer();