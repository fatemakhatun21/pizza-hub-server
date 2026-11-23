import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import test from "node:test";
import assert from "node:assert/strict";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

import { withVendorItemLimit } from "../services/vendorItemLimit.js";

test(
    "concurrent activations never exceed 3 active pizzas",
    { skip: !process.env.TEST_MONGODB_URI },
    async () => {
        const client = new MongoClient(process.env.TEST_MONGODB_URI);
        const dbName = "pizzahub_limit_test";

        await client.connect();
        const db = client.db(dbName);

        const vendorId = new ObjectId();
        const vendorIdString = vendorId.toHexString();

        try {

            await db.collection("user").insertOne({
                _id: vendorId,
                role: "vendor",
                plan: "free",
                blocked: false,
            });

            const pizzas = Array.from({ length: 5 }, (_, i) => ({
                _id: new ObjectId(),
                name: `Test Pizza ${i + 1}`,
                vendorId: vendorIdString,
                status: "approved",
                isActive: i < 2,
            }));

            await db.collection("menuItems").insertMany(pizzas);

            // Three requests compete for the one remaining slot.
            const results = await Promise.all(
                pizzas.slice(2).map((pizza) =>
                    withVendorItemLimit({
                        client,
                        db,
                        vendorId: vendorIdString,
                        activating: true,
                        mutate: async ({ session }) => {
                            const result = await db
                                .collection("menuItems")
                                .updateOne(
                                    {
                                        _id: pizza._id,
                                        status: "approved",
                                        isActive: false,
                                    },
                                    {
                                        $set: { isActive: true },
                                    },
                                    { session }
                                );

                            return {
                                status: result.matchedCount ? 200 : 409,
                            };
                        },
                    })
                )
            );

            const activeCount = await db
                .collection("menuItems")
                .countDocuments({
                    vendorId: vendorIdString,
                    status: "approved",
                    isActive: true,
                });

            assert.equal(activeCount, 3);

            assert.equal(
                results.filter((result) => result.status === 200).length,
                1
            );

            assert.equal(
                results.filter((result) => result.status === 403).length,
                2
            );
        } finally {
            try {
                await db.collection("menuItems").deleteMany({
                    name: /^Test Pizza \d+$/,
                    vendorId: vendorIdString,
                });

                await db.collection("user").deleteOne({
                    _id: vendorId,
                });
            } finally {
                await client.close();
            }
        }
    }
);
