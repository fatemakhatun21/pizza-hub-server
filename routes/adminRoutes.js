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

            if (!user || user.role !== "admin") {
                return res.status(403).json({
                    message: "Admin access required",
                });
            }

            req.user = user;
            next();
        } catch (error) {
            console.error("Admin auth error:", error.message);
            res.status(500).json({
                message: "Failed to verify admin",
            });
        }
    };

    router.get("/menu", requireAdmin, async (req, res) => {
        try {
            const items = await menuCollection
                .find()
                .sort({ createdAt: -1 })
                .toArray();

            res.status(200).json(items);
        } catch (error) {
            console.error(error);
            res.status(500).json({
                message: "Failed to fetch pizzas",
            });
        }
    });

    router.patch("/menu/:id/status", requireAdmin, async (req, res) => {
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

            const result = await menuCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    status: "pending",
                },
                {
                    $set: {
                        status,
                        isActive: status === "approved",
                        reviewedBy: req.user._id.toString(),
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
    });

    return router;
}
