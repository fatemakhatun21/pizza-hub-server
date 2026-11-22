import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";

export default function createAdminRoutes(db, auth) {
    const router = Router();

    const usersCollection = db.collection("user");
    const menuCollection = db.collection("menuItems");

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

                    const vendor = await usersCollection.findOne({
                        _id: new ObjectId(pizza.vendorId),
                        role: "vendor",
                        blocked: { $ne: true },
                    });

                    if (!vendor) {
                        return res.status(403).json({
                            message: "Vendor account is unavailable",
                        });
                    }

                    if (vendor.plan !== "premium") {
                        const activeCount = await menuCollection.countDocuments({
                            vendorId: pizza.vendorId,
                            status: "approved",
                            isActive: true,
                        });

                        if (activeCount >= 3) {
                            return res.status(403).json({
                                message:
                                    "Free vendors can have a maximum of 3 active pizzas",
                            });
                        }
                    }
                }

                const result = await menuCollection.updateOne(
                    {
                        _id: new ObjectId(id),
                        status: "pending",
                    },
                    {
                        $set: {
                            status,
                            isActive: status === "approved",
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

    return router;
}
