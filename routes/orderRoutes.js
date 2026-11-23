import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { sendOrderStatusEmail } from "../services/emailService.js";
import { PUBLIC_MENU_FILTER } from "../utils/menuFilters.js";
import { isDuplicateKeyFor } from "../utils/mongoErrors.js";
import {
    ACTIVE_ORDER_STATUSES,
    getDeliveryDateKey,
    normalizeOrderMessage,
} from "../utils/orderRules.js";

export default function createOrderRoutes(db, auth) {
    const router = Router();

    const orders = db.collection("orders");
    const menuItems = db.collection("menuItems");
    const users = db.collection("user");

    const requireAuth = async (req, res, next) => {
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

            const user = await users.findOne({
                _id: new ObjectId(session.user.id),
            });

            if (!user || user.blocked === true) {
                return res.status(403).json({
                    message: "Account unavailable or blocked",
                });
            }

            req.user = {
                ...user,
                id: session.user.id,
            };

            next();
        } catch (error) {
            console.error("Order auth error:", error.message);
            res.status(500).json({
                message: "Authentication failed",
            });
        }
    };

    const requireRole = (role) => (req, res, next) => {
        if (req.user.role !== role) {
            return res.status(403).json({
                message: `Only ${role}s can access this resource`,
            });
        }

        next();
    };
    router.post(
        "/",
        requireAuth,
        requireRole("customer"),
        async (req, res) => {
            try {
                const {
                    pizzaId,
                    quantity,
                    deliveryAddress,
                    deliveryDate,
                    message,
                    specialInstructions,
                } = req.body ?? {};

                if (!ObjectId.isValid(pizzaId)) {
                    return res.status(400).json({
                        message: "Invalid pizza ID",
                    });
                }

                if (
                    !Number.isInteger(quantity) ||
                    quantity < 1 ||
                    quantity > 20
                ) {
                    return res.status(400).json({
                        message: "Quantity must be between 1 and 20",
                    });
                }

                if (
                    typeof deliveryAddress !== "string" ||
                    !deliveryAddress.trim()
                ) {
                    return res.status(400).json({
                        message: "Delivery address is required",
                    });
                }

                const date = new Date(deliveryDate);

                if (
                    !deliveryDate ||
                    Number.isNaN(date.getTime()) ||
                    date <= new Date()
                ) {
                    return res.status(400).json({
                        message: "Choose a future delivery date",
                    });
                }

                const messageResult = normalizeOrderMessage(
                    message ?? specialInstructions
                );

                if (!messageResult.ok) {
                    return res.status(400).json({
                        message: messageResult.message,
                    });
                }

                const deliveryDateKey = getDeliveryDateKey(deliveryDate);

                if (!deliveryDateKey) {
                    return res.status(400).json({
                        message: "Choose a valid delivery date",
                    });
                }

                const pizza = await menuItems.findOne({
                    ...PUBLIC_MENU_FILTER,
                    _id: new ObjectId(pizzaId),
                });

                if (!pizza || !pizza.vendorId) {
                    return res.status(404).json({
                        message: "Pizza is unavailable",
                    });
                }

                if (String(pizza.vendorId) === String(req.user.id)) {
                    return res.status(403).json({
                        message: "Vendors cannot order their own pizzas",
                    });
                }

                const canonicalPizzaId = pizza._id.toString();
                const existingOrder = await orders.findOne({
                    customerId: req.user.id,
                    pizzaId: canonicalPizzaId,
                    deliveryDateKey,
                    status: { $in: ACTIVE_ORDER_STATUSES },
                });

                if (existingOrder) {
                    return res.status(409).json({
                        message:
                            "You already have an active order for this pizza on that delivery date",
                    });
                }

                const order = {
                    customerId: req.user.id,
                    customerName: req.user.name,
                    customerEmail: req.user.email,

                    vendorId: pizza.vendorId,
                    vendorName: pizza.vendorName || pizza.vendor || "",
                    pizzaId: canonicalPizzaId,
                    pizzaName: pizza.name,
                    pizzaImage: pizza.image,

                    quantity,
                    unitPrice: pizza.price,
                    totalPrice: Number(
                        (pizza.price * quantity).toFixed(2)
                    ),

                    deliveryAddress: deliveryAddress.trim(),
                    deliveryDate: date,
                    deliveryDateKey,
                    message: messageResult.value,

                    status: "pending",
                    timeline: [
                        {
                            status: "pending",
                            at: new Date(),
                            note: "Order placed",
                        },
                    ],
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                let result;

                try {
                    result = await orders.insertOne(order);
                } catch (error) {
                    // The partial unique index is the authoritative guard.
                    // This catch only converts its race outcome into the same
                    // 409 response as the pre-check above.
                    if (
                        isDuplicateKeyFor(error, [
                            "customerId",
                            "pizzaId",
                            "deliveryDateKey",
                        ])
                    ) {
                        return res.status(409).json({
                            message:
                                "You already have an active order for this pizza on that delivery date",
                        });
                    }

                    throw error;
                }

                res.status(201).json({
                    message: "Order placed successfully",
                    insertedId: result.insertedId,
                });
            } catch (error) {
                console.error("Create order error:", error.message);
                res.status(500).json({
                    message: "Failed to place order",
                });
            }
        }
    );

    router.get(
        "/mine",
        requireAuth,
        requireRole("customer"),
        async (req, res) => {
            try {
                const result = await orders
                    .find({ customerId: req.user.id })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json(result);
            } catch (error) {
                console.error("My orders error:", error.message);
                res.status(500).json({
                    message: "Failed to fetch orders",
                });
            }
        }
    );

    router.get(
        "/vendor",
        requireAuth,
        requireRole("vendor"),
        async (req, res) => {
            try {
                const result = await orders
                    .find({ vendorId: req.user.id })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json(result);
            } catch (error) {
                console.error("Vendor orders error:", error.message);
                res.status(500).json({
                    message: "Failed to fetch vendor orders",
                });
            }
        }
    );

    router.patch(
        "/:id/status",
        requireAuth,
        requireRole("vendor"),
        async (req, res) => {
            try {
                const { id } = req.params;
                const { status } = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid order ID",
                    });
                }

                const allowedStatuses = [
                    "accepted",
                    "rejected",
                    "preparing",
                    "out_for_delivery",
                    "delivered",
                ];

                if (!allowedStatuses.includes(status)) {
                    return res.status(400).json({
                        message: "Invalid order status",
                    });
                }

                const requiredCurrentStatus = {
                    accepted: "pending",
                    rejected: "pending",
                    preparing: "accepted",
                    out_for_delivery: "preparing",
                    delivered: "out_for_delivery",
                }[status];

                const at = new Date();

                const result = await orders.updateOne(
                    {
                        _id: new ObjectId(id),
                        vendorId: req.user.id,
                        status: requiredCurrentStatus,
                    },
                    {
                        $set: {
                            status,
                            updatedAt: at,
                        },
                        $push: {
                            timeline: {
                                status,
                                at,
                                note: `Order ${status.replace(/_/g, " ")}`,
                            },
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        message: "Order unavailable or invalid status transition",
                    });
                }

                // Email only on acceptance/rejection. Delivery issues are logged
                // but never roll back the status change or fail this response.
                if (status === "accepted" || status === "rejected") {
                    try {
                        const order = await orders.findOne({
                            _id: new ObjectId(id),
                        });

                        if (order?.customerEmail) {
                            const emailResult = await sendOrderStatusEmail({
                                to: order.customerEmail,
                                customerName: order.customerName,
                                pizzaName: order.pizzaName,
                                status,
                                orderId: order._id.toString(),
                                clientUrl: process.env.CLIENT_URL,
                            });

                            if (!emailResult.ok && !emailResult.skipped) {
                                console.error(
                                    "Order status email delivery failed:",
                                    emailResult.reason ?? "unknown error"
                                );
                            }
                        }
                    } catch (emailError) {
                        console.error(
                            "Order status email error:",
                            emailError.message
                        );
                    }
                }

                res.status(200).json({
                    message: `Order ${status} successfully`,
                });
            } catch (error) {
                console.error("Update order error:", error.message);
                res.status(500).json({
                    message: "Failed to update order",
                });
            }
        }
    );

    router.patch(
        "/:id/cancel",
        requireAuth,
        requireRole("customer"),
        async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid order ID",
                    });
                }

                const at = new Date();

                const result = await orders.updateOne(
                    {
                        _id: new ObjectId(id),
                        customerId: req.user.id,
                        status: "pending",
                    },
                    {
                        $set: {
                            status: "cancelled",
                            updatedAt: at,
                        },
                        $push: {
                            timeline: {
                                status: "cancelled",
                                at,
                                note: "Order cancelled",
                            },
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(409).json({
                        message: "Order unavailable or cannot be cancelled",
                    });
                }

                res.status(200).json({
                    message: "Order cancelled successfully",
                });
            } catch (error) {
                console.error("Cancel order error:", error.message);
                res.status(500).json({
                    message: "Failed to cancel order",
                });
            }
        }
    );

    return router;
}
