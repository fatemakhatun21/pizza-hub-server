import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import "dotenv/config";
import { MongoClient, ServerApiVersion } from "mongodb";

import { verifyRequiredIndexes } from "../services/dbIndexes.js";

/**
 * Read-only index verification for operators.
 *
 * This script only calls collection.indexes(). It does not create, drop, or
 * rebuild indexes and does not modify any documents.
 */
const uri = process.env.MONGODB_URI;

if (!uri) {
    console.error("MONGODB_URI is missing from .env");
    process.exit(1);
}

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

try {
    await client.connect();
    const db = client.db("pizzahub_db");
    const result = await verifyRequiredIndexes(db, console, { strict: false });

    if (result.ok) {
        console.log("Required database indexes are present and valid.");
    } else {
        console.error(
            `Required database index verification failed (${result.problems.length} problem(s)).`
        );
    }

    process.exitCode = result.ok ? 0 : 1;
} catch (error) {
    console.error("Database index verification failed:", error.message);
    process.exitCode = 1;
} finally {
    await client.close();
}
