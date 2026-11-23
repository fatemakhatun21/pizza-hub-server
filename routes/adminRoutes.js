import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { withVendorItemLimit } from "../services/vendorItemLimit.js";

export default function createAdminRoutes(db, auth, client) {
    const router = Router();

    const usersCollection = db.collection("user");
    const menuCollection = db.collection("menuItems");
    const ordersCollection = db.collection("orders");
    const transactionsCollection = db.collection("transactions");

    const requireAdmin = async (req, res, next) => {
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
                return res.status(403).json({
                    message: "Admin access required",
                });
            }

            const user = await usersCollection.findOne({
                _id: new ObjectId(session.user.id),
            });

            if (
                !user ||
                user.role !== "admin" ||
                user.blocked === true
            ) {
                return res.status(403).json({
                    message: "Admin access required",
                });
            }

            req.user = {
                ...user,
                id: session.user.id,
            };

            next();
        } catch (error) {
            console.error("Admin auth error:", error.message);

            res.status(500).json({
                message: "Failed to verify admin",
            });
        }
    };

    router.get("/users", requireAdmin, async (req, res) => {
        try {
            const users = await usersCollection
                .find(
                    {},
                    {
                        projection: {
                            name: 1,
                            email: 1,
                            role: 1,
                            blocked: 1,
                            createdAt: 1,
                        },
                    }
                )
                .sort({ createdAt: -1 })
                .toArray();

            res.status(200).json(users);
        } catch (error) {
            console.error("Fetch users error:", error.message);

            res.status(500).json({
                message: "Failed to fetch users",
            });
        }
    });

    // Block or unblock a user
    router.patch(
        "/users/:id/block",
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;
                const { blocked } = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid user ID",
                    });
                }

                if (typeof blocked !== "boolean") {
                    return res.status(400).json({
                        message: "Blocked must be true or false",
                    });
                }

                if (id === req.user.id) {
                    return res.status(403).json({
                        message: "You cannot block yourself",
                    });
                }

                const result = await usersCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        role: { $ne: "admin" },
                    },
                    {
                        $set: {
                            blocked,
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({
                        message: "User not found or cannot be modified",
                    });
                }

                res.status(200).json({
                    message: blocked
                        ? "User blocked successfully"
                        : "User unblocked successfully",
                });
            } catch (error) {
                console.error("Update user error:", error.message);

                res.status(500).json({
                    message: "Failed to update user status",
                });
            }
        }
    );

    router.get("/menu", requireAdmin, async (req, res) => {
        try {
            const items = await menuCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();

            res.status(200).json(items);
        } catch (error) {
            console.error("Fetch menu error:", error.message);

            res.status(500).json({
                message: "Failed to fetch pizzas",
            });
        }
    });

    router.patch(
        "/menu/:id/status",
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid pizza ID",
                    });
                }

                if (!["approved", "rejected"].includes(status)) {
                    return res.status(400).json({
                        message: "Status must be approved or rejected",
                    });
                }


                if (status === "approved") {
                    const pizza = await menuCollection.findOne({
                        _id: new ObjectId(id),
                        status: "pending",
                    });

                    if (!pizza) {
                        return res.status(409).json({
                            message: "Pizza not found or no longer pending",
                        });
                    }

                    if (!pizza.vendorId || !ObjectId.isValid(pizza.vendorId)) {
                        return res.status(400).json({
                            message: "Pizza has an invalid vendor ID",
                        });
                    }

                    const outcome = await withVendorItemLimit({
                        client,
                        db,
                        vendorId: pizza.vendorId,
                        activating: true,
                        mutate: async ({ session }) => {
                            const result = await menuCollection.updateOne(
                                {
                                    _id: new ObjectId(id),
                                    status: "pending",
                                },
                                {
                                    $set: {
                                        status: "approved",
                                        isActive: true,
                                        reviewedBy: req.user.id,
                                        reviewedAt: new Date(),
                                    },
                                },
                                { session }
                            );

                            return result.matchedCount
                                ? { status: 200, message: "Pizza approved successfully" }
                                : { status: 409, message: "Pizza no longer pending" };
                        },
                    });

                    return res.status(outcome.status).json({
                        message: outcome.message,
                    });
                }

                const result = await menuCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        status: "pending",
                    },
                    {
                        $set: {
                            status,
                            isActive: false,
                            reviewedBy: req.user.id,
                            reviewedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        message: "Pizza not found or no longer pending",
                    });
                }

                res.status(200).json({
                    message: `Pizza ${status} successfully`,
                });
            } catch (error) {
                console.error("Pizza review error:", error.message);

                res.status(500).json({
                    message: "Failed to review pizza",
                });
            }
        }
    );

    router.patch(
        "/menu/:id/feature",
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;
                const { isFeatured } = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid pizza ID",
                    });
                }

                if (typeof isFeatured !== "boolean") {
                    return res.status(400).json({
                        message: "isFeatured must be true or false",
                    });
                }

                const result = await menuCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                    },
                    {
                        $set: {
                            isFeatured,
                            updatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({
                        message: "Pizza not found",
                    });
                }

                res.status(200).json({
                    message: "Featured status updated successfully",
                });
            } catch (error) {
                console.error("Update featured pizza error:", error.message);

                res.status(500).json({
                    message: "Failed to update featured pizza",
                });
            }
        }
    );

    router.get("/stats", requireAdmin, async (req, res) => {
        try {
            const [
                totalUsers,
                customers,
                vendors,
                admins,
                blockedUsers,
                totalPizzas,
                pendingPizzas,
                approvedPizzas,
                rejectedPizzas,
                featuredPizzas,
            ] = await Promise.all([
                usersCollection.countDocuments({}),
                usersCollection.countDocuments({ role: "customer" }),
                usersCollection.countDocuments({ role: "vendor" }),
                usersCollection.countDocuments({ role: "admin" }),
                usersCollection.countDocuments({ blocked: true }),
                menuCollection.countDocuments({}),
                menuCollection.countDocuments({ status: "pending" }),
                menuCollection.countDocuments({ status: "approved" }),
                menuCollection.countDocuments({ status: "rejected" }),
                menuCollection.countDocuments({ isFeatured: true }),
            ]);

            const [orderStatsDoc] = await ordersCollection
                .aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            pending: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "pending"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            accepted: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "accepted"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            preparing: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "preparing"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            out_for_delivery: {
                                $sum: {
                                    $cond: [
                                        {
                                            $eq: [
                                                "$status",
                                                "out_for_delivery",
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            delivered: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "delivered"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            rejected: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "rejected"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            cancelled: {
                                $sum: {
                                    $cond: [
                                        { $eq: ["$status", "cancelled"] },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            revenue: {
                                $sum: {
                                    $cond: [
                                        { $ne: ["$status", "cancelled"] },
                                        { $ifNull: ["$totalPrice", 0] },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ])
                .toArray();

            const orderStats = orderStatsDoc || {};

            const [transactionStatsDoc] = await transactionsCollection
                .aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            completedAmount: {
                                $sum: {
                                    $cond: [
                                        {
                                            $in: [
                                                { $ifNull: ["$status", ""] },
                                                ["succeeded", "completed"],
                                            ],
                                        },
                                        {
                                            $convert: {
                                                input: {
                                                    $ifNull: [
                                                        "$amountTotal",
                                                        0,
                                                    ],
                                                },
                                                to: "double",
                                                onError: 0,
                                                onNull: 0,
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                        },
                    },
                ])
                .toArray();

            const transactionStats = transactionStatsDoc || {};

            const now = new Date();
            const monthlyOrders = [];

            for (let offset = 5; offset >= 0; offset -= 1) {
                const monthStart = new Date(
                    Date.UTC(
                        now.getUTCFullYear(),
                        now.getUTCMonth() - offset,
                        1
                    )
                );
                const monthEnd = new Date(
                    Date.UTC(
                        monthStart.getUTCFullYear(),
                        monthStart.getUTCMonth() + 1,
                        1
                    )
                );

                const value = await ordersCollection.countDocuments({
                    createdAt: {
                        $gte: monthStart,
                        $lt: monthEnd,
                    },
                });

                monthlyOrders.push({
                    label: monthStart.toLocaleString("en-US", {
                        month: "short",
                        timeZone: "UTC",
                    }),
                    value,
                });
            }

            res.status(200).json({
                users: {
                    total: totalUsers,
                    customers,
                    vendors,
                    admins,
                    blocked: blockedUsers,
                },
                pizzas: {
                    total: totalPizzas,
                    pending: pendingPizzas,
                    approved: approvedPizzas,
                    rejected: rejectedPizzas,
                    featured: featuredPizzas,
                },
                orders: {
                    total: orderStats.total || 0,
                    pending: orderStats.pending || 0,
                    accepted: orderStats.accepted || 0,
                    preparing: orderStats.preparing || 0,
                    out_for_delivery: orderStats.out_for_delivery || 0,
                    delivered: orderStats.delivered || 0,
                    rejected: orderStats.rejected || 0,
                    cancelled: orderStats.cancelled || 0,
                    revenue: Number((orderStats.revenue || 0).toFixed(2)),
                },
                transactions: {
                    total: transactionStats.total || 0,
                    completedAmount: Number(
                        (transactionStats.completedAmount || 0).toFixed(2)
                    ),
                },
                monthlyOrders,
            });
        } catch (error) {
            console.error("Fetch stats error:", error.message);

            res.status(500).json({
                message: "Failed to fetch statistics",
            });
        }
    });

    router.get("/transactions", requireAdmin, async (req, res) => {
        try {
            const parsedLimit = Number.parseInt(req.query.limit, 10);
            const parsedSkip = Number.parseInt(req.query.skip, 10);

            const limit =
                Number.isFinite(parsedLimit) && parsedLimit > 0
                    ? Math.min(parsedLimit, 100)
                    : 50;
            const skip =
                Number.isFinite(parsedSkip) && parsedSkip > 0
                    ? parsedSkip
                    : 0;

            const transactions = await transactionsCollection
                .find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray();

            res.status(200).json(transactions);
        } catch (error) {
            console.error("Fetch transactions error:", error.message);

            res.status(500).json({
                message: "Failed to fetch transactions",
            });
        }
    });

    return router;
}
