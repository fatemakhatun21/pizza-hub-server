import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";

import createMenuRoutes from "./routes/menuRoutes.js";
import createAdminRoutes from "./routes/adminRoutes.js";
import { createAuth } from "./config/auth.js";

const app = express();
const port = process.env.PORT || 5000;

app.use(
    cors({
        origin: "http://localhost:3000",
        credentials: true,
    })
);

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

        app.all("/api/auth/*splat", toNodeHandler(auth));

        app.use(express.json());

        const verifySession = async (req, res, next) => {
            try {
                const session = await auth.api.getSession({
                    headers: fromNodeHeaders(req.headers),
                });

                if (!session?.user) {
                    return res.status(401).json({
                        message: "Unauthorized. Please sign in.",
                    });
                }

                req.user = session.user;
                req.session = session.session;

                next();
            } catch (error) {
                console.error("Session verification error:", error.message);

                return res.status(500).json({
                    message: "Unable to verify session.",
                });
            }
        };

        app.get("/api/me", verifySession, (req, res) => {
            res.status(200).json({
                user: req.user,
            });
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
        app.use("/api/menu", createMenuRoutes(menuCollection, auth, db));
        app.use("/api/admin", createAdminRoutes(db, auth));

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