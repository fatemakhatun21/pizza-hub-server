import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { withVendorItemLimit } from "../services/vendorItemLimit.js";
import {
    NOT_DELETED_FILTER,
    PUBLIC_MENU_FILTER,
} from "../utils/menuFilters.js";

// Only settled, fulfilled orders represent earned revenue. Pending may still
// be rejected, and rejected/cancelled orders must never inflate revenue.
const REVENUE_ORDER_STATUSES = [
    "accepted",
    "preparing",
    "out_for_delivery",
    "delivered",
];

// Pending items are reviewed first. Published items can later be taken down
// or restored; adminPublished remains a separate visibility flag.
const MENU_STATUS_TRANSITIONS = {
    pending: ["approved", "rejected"],
    approved: ["inactive", "rejected"],
    rejected: ["approved"],
    inactive: ["approved"],
};

const firstValue = (value) =>
    Array.isArray(value) ? firstValue(value[0]) : value;

const transactionVendorId = (transaction) =>
    transaction?.vendorId || transaction?.userId || transaction?.customerId || null;

const normalizeTransaction = (transaction, vendorsById) => {
    const vendorId = transactionVendorId(transaction);
    const vendor = vendorId ? vendorsById.get(String(vendorId)) : null;
    const type = String(transaction?.type ?? "");
    const explicitPlan = transaction?.plan;
    const plan =
        explicitPlan ||
        (/premium|subscription/i.test(type) ? "premium" : "unknown");

    const amount = Number(
        transaction?.amount ??
            transaction?.amountTotal ??
            (transaction?.amountTotalMinor != null
                ? Number(transaction.amountTotalMinor) / 100
                : 0)
    );

    return {
        ...transaction,
        vendorId,
        vendor,
        plan,
        amount: Number.isFinite(amount) ? amount : 0,
        amountTotal: Number.isFinite(amount) ? amount : 0,
        currency: transaction?.currency || "usd",
        paymentStatus: transaction?.paymentStatus || transaction?.status || "unknown",
        status: transaction?.status || transaction?.paymentStatus || "unknown",
        createdAt: transaction?.createdAt ?? transaction?.updatedAt ?? null,
    };
};

export default function createAdminRoutes(db, auth, client) {
    const router = Router();

    const usersCollection = db.collection("user");
    const menuCollection = db.collection("menuItems");
    const ordersCollection = db.collection("orders");
    const transactionsCollection = db.collection("transactions");

    const withAdminMenuFlags = (items) =>
        items.map((item) => ({
            ...item,
            adminPublished: item?.adminPublished !== false,
            vendorAvailable: item?.isActive === true,
            publiclyVisible:
                item?.status === "approved" &&
                item?.isActive === true &&
                item?.adminPublished !== false &&
                item?.isDeleted !== true,
        }));

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
                .find(NOT_DELETED_FILTER)
                .sort({ createdAt: -1 })
                .toArray();

            const search = String(firstValue(req.query.search) ?? "")
                .trim()
                .toLowerCase();
            const status = String(firstValue(req.query.status) ?? "")
                .trim()
                .toLowerCase();
            const category = String(firstValue(req.query.category) ?? "")
                .trim()
                .toLowerCase();
            const location = String(firstValue(req.query.location) ?? "")
                .trim()
                .toLowerCase();
            const sort = String(firstValue(req.query.sort) ?? "")
                .trim()
                .toLowerCase();

            let filtered = items.filter((item) => {
                if (
                    search &&
                    !`${item.name ?? ""} ${item.description ?? ""}`
                        .toLowerCase()
                        .includes(search)
                ) {
                    return false;
                }

                if (status && String(item.status ?? "").toLowerCase() !== status) {
                    return false;
                }

                if (
                    category &&
                    String(item.category ?? "").toLowerCase() !== category
                ) {
                    return false;
                }

                if (
                    location &&
                    !String(item.location ?? "")
                        .toLowerCase()
                        .includes(location)
                ) {
                    return false;
                }

                return true;
            });

            if (sort === "price_asc" || sort === "low") {
                filtered = [...filtered].sort(
                    (a, b) => Number(a.price ?? 0) - Number(b.price ?? 0)
                );
            } else if (sort === "price_desc" || sort === "high") {
                filtered = [...filtered].sort(
                    (a, b) => Number(b.price ?? 0) - Number(a.price ?? 0)
                );
            }

            res.status(200).json(withAdminMenuFlags(filtered));
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

                if (
                    !["approved", "rejected", "inactive"].includes(status)
                ) {
                    return res.status(400).json({
                        message: "Status must be approved, rejected or inactive",
                    });
                }

                const pizza = await menuCollection.findOne({
                    ...NOT_DELETED_FILTER,
                    _id: new ObjectId(id),
                });

                if (!pizza) {
                    return res.status(404).json({
                        message: "Pizza not found",
                    });
                }

                const currentStatus = String(pizza.status ?? "pending");
                const allowedNext = MENU_STATUS_TRANSITIONS[currentStatus] ?? [];

                if (!allowedNext.includes(status)) {
                    return res.status(409).json({
                        message: `Cannot change ${currentStatus} pizza to ${status}`,
                    });
                }

                if (status === "approved") {
                    if (!pizza.vendorId || !ObjectId.isValid(pizza.vendorId)) {
                        return res.status(400).json({
                            message: "Pizza has an invalid vendor ID",
                        });
                    }

                    const outcome = await withVendorItemLimit({
                        client,
                        db,
                        vendorId: pizza.vendorId,
                        // Vendor availability is authoritative. Only legacy
                        // pending items that are already active count as an
                        // activation for the free-plan limit.
                        activating: pizza.isActive === true,
                        mutate: async ({ session }) => {
                            const result = await menuCollection.updateOne(
                                {
                                    ...NOT_DELETED_FILTER,
                                    _id: new ObjectId(id),
                                    status: currentStatus,
                                },
                                {
                                    $set: {
                                        status: "approved",
                                        adminPublished: true,
                                        reviewedBy: req.user.id,
                                        reviewedAt: new Date(),
                                    },
                                },
                                { session }
                            );

                            return result.matchedCount
                                ? { status: 200, message: "Pizza approved successfully" }
                                : { status: 409, message: "Pizza status changed. Please refresh." };
                        },
                    });

                    return res.status(outcome.status).json({
                        message: outcome.message,
                    });
                }

                const updates = {
                    status,
                    adminPublished: false,
                    reviewedBy: req.user.id,
                    reviewedAt: new Date(),
                    updatedAt: new Date(),
                };

                if (status === "rejected") {
                    updates.isActive = false;
                }

                const result = await menuCollection.updateOne(
                    {
                        ...NOT_DELETED_FILTER,
                        _id: new ObjectId(id),
                        status: currentStatus,
                    },
                    { $set: updates }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        message: "Pizza status changed. Please refresh.",
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
        "/menu/:id/availability",
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;
                const { isActive } = req.body ?? {};

                if (
                    !ObjectId.isValid(id) ||
                    String(new ObjectId(id)) !== id.toLowerCase()
                ) {
                    return res.status(400).json({
                        message: "Invalid pizza ID",
                    });
                }

                if (typeof isActive !== "boolean") {
                    return res.status(400).json({
                        message: "isActive must be true or false",
                    });
                }

                const pizza = await menuCollection.findOne({
                    ...NOT_DELETED_FILTER,
                    _id: new ObjectId(id),
                    status: "approved",
                });

                if (!pizza) {
                    return res.status(409).json({
                        message: "Pizza not found or no longer approved",
                    });
                }

                if (!pizza.vendorId || !ObjectId.isValid(pizza.vendorId)) {
                    return res.status(400).json({
                        message: "Pizza has an invalid vendor ID",
                    });
                }

                const adminPublished = pizza.adminPublished !== false;
                const vendorAvailable = pizza.isActive === true;

                if (adminPublished === isActive) {
                    return res.status(200).json({
                        message: "Admin visibility is already up to date",
                        isActive,
                        adminPublished,
                        vendorAvailable,
                        publiclyVisible: adminPublished && vendorAvailable,
                    });
                }

                const outcome = await withVendorItemLimit({
                    client,
                    db,
                    vendorId: pizza.vendorId,
                    // Admin publication only makes an item public when the
                    // vendor has already marked it available.
                    activating: isActive && vendorAvailable,
                    mutate: async ({ session }) => {
                        const result = await menuCollection.updateOne(
                            {
                                ...NOT_DELETED_FILTER,
                                _id: new ObjectId(id),
                                status: "approved",
                            },
                            {
                                $set: {
                                    adminPublished: isActive,
                                    updatedAt: new Date(),
                                },
                            },
                            { session }
                        );

                        return result.matchedCount
                            ? {
                                status: 200,
                                message: isActive
                                    ? "Pizza is now publicly visible"
                                    : "Pizza is hidden from public listings",
                                isActive,
                                adminPublished: isActive,
                                vendorAvailable,
                                publiclyVisible:
                                    isActive && vendorAvailable,
                            }
                            : {
                                status: 409,
                                message:
                                    "Pizza visibility changed. Please refresh.",
                            };
                    },
                });

                return res.status(outcome.status).json(outcome);
            } catch (error) {
                console.error("Pizza visibility error:", error.message);

                return res.status(500).json({
                    message: "Failed to update pizza visibility",
                });
            }
        }
    );

    router.delete("/menu/:id", requireAdmin, async (req, res) => {
        try {
            const { id } = req.params;

            if (
                !ObjectId.isValid(id) ||
                String(new ObjectId(id)) !== id.toLowerCase()
            ) {
                return res.status(400).json({
                    message: "Invalid pizza ID",
                });
            }

            const filter = {
                ...NOT_DELETED_FILTER,
                _id: new ObjectId(id),
            };

            const pizza = await menuCollection.findOne(filter);

            if (!pizza) {
                return res.status(404).json({
                    message: "Pizza not found",
                });
            }

            // Soft delete: keep the document so existing orders and reviews
            // still reference a real pizza. Public/vendor/admin queries exclude
            // soft-deleted items via NOT_DELETED_FILTER.
            const result = await menuCollection.updateOne(filter, {
                $set: {
                    adminPublished: false,
                    isDeleted: true,
                    deletedAt: new Date(),
                    deletedBy: req.user.id,
                    updatedAt: new Date(),
                },
            });

            if (result.matchedCount === 0) {
                return res.status(409).json({
                    message: "Pizza availability changed. Please refresh.",
                });
            }

            return res.status(200).json({
                message: "Pizza deleted successfully",
            });
        } catch (error) {
            console.error("Admin pizza deletion error:", error.message);

            return res.status(500).json({
                message: "Failed to delete pizza",
            });
        }
    });

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
                        ...(isFeatured
                            ? PUBLIC_MENU_FILTER
                            : NOT_DELETED_FILTER),
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
                menuCollection.countDocuments(NOT_DELETED_FILTER),
                menuCollection.countDocuments({
                    ...NOT_DELETED_FILTER,
                    status: "pending",
                }),
                menuCollection.countDocuments({
                    ...NOT_DELETED_FILTER,
                    status: "approved",
                }),
                menuCollection.countDocuments({
                    ...NOT_DELETED_FILTER,
                    status: "rejected",
                }),
                menuCollection.countDocuments({
                    ...PUBLIC_MENU_FILTER,
                    isFeatured: true,
                }),
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
                                        {
                                            $in: [
                                                { $ifNull: ["$status", ""] },
                                                REVENUE_ORDER_STATUSES,
                                            ],
                                        },
                                        {
                                            $convert: {
                                                input: {
                                                    $ifNull: [
                                                        "$totalPrice",
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

            const orderStats = orderStatsDoc || {};

            const [transactionStatsDoc] = await transactionsCollection
                .aggregate([
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            successful: {
                                $sum: {
                                    $cond: [
                                        {
                                            $in: [
                                                { $ifNull: ["$status", ""] },
                                                [
                                                    "paid",
                                                    "succeeded",
                                                    "success",
                                                    "complete",
                                                    "completed",
                                                ],
                                            ],
                                        },
                                        1,
                                        0,
                                    ],
                                },
                            },
                            completedAmount: {
                                $sum: {
                                    $cond: [
                                        {
                                            $in: [
                                                { $ifNull: ["$status", ""] },
                                                [
                                                    "paid",
                                                    "succeeded",
                                                    "success",
                                                    "complete",
                                                    "completed",
                                                ],
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
                    successful: transactionStats.successful || 0,
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

            const vendorIds = [
                ...new Set(
                    transactions
                        .map(transactionVendorId)
                        .filter((id) => id && ObjectId.isValid(id))
                        .map((id) => String(id))
                ),
            ];

            const vendors = vendorIds.length
                ? await usersCollection
                      .find(
                          { _id: { $in: vendorIds.map((id) => new ObjectId(id)) } },
                          {
                              projection: {
                                  name: 1,
                                  email: 1,
                                  businessName: 1,
                              },
                          }
                      )
                      .toArray()
                : [];

            const vendorsById = new Map(
                vendors.map((vendor) => [String(vendor._id), vendor])
            );

            res.status(200).json(
                transactions.map((transaction) =>
                    normalizeTransaction(transaction, vendorsById)
                )
            );
        } catch (error) {
            console.error("Fetch transactions error:", error.message);

            res.status(500).json({
                message: "Failed to fetch transactions",
            });
        }
    });

    return router;
}
