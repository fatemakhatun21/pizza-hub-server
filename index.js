import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);
import "dotenv/config";
import express from "express";
import cors from "cors";
import createMenuRoutes from "./routes/menuRoutes.js";
import { toNodeHandler } from "better-auth/node";
import { createAuth } from "./config/auth.js";

import { MongoClient, ServerApiVersion } from "mongodb";

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

        const menuCollection = db.collection("menuItems");
        app.use("/api/menu", createMenuRoutes(menuCollection));

        app.get("/", (req, res) => {
            res.send("PizzaHub Server is Running!");
        });

        app.get("/api/menu", async (req, res) => {
            try {
                const items = await menuCollection.find().toArray();
                res.json(items);
            } catch (error) {
                console.error("Failed to fetch menu:", error.message);
                res.status(500).json({
                    message: "Failed to fetch menu items",
                });
            }
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
