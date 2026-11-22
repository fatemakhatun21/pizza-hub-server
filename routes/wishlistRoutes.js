import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";

export default function createWishlistRoutes(db, auth) {
    const router = Router();

    const wishlist = db.collection("wishlist");
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
            console.error("Wishlist auth error:", error.message);

            res.status(500).json({
                message: "Unable to verify permission",
            });
        }
    };

    const isValidId = (id) => {
        if (typeof id !== "string") {
            return false;
        }

        return (
            ObjectId.isValid(id) &&
            String(new ObjectId(id)) === id.toLowerCase()
        );
    };

    router.get("/", requireAuth, async (req, res) => {
        try {
            const entries = await wishlist
                .find({ customerId: req.user.id })
                .sort({ createdAt: -1 })
                .toArray();

            const pizzaIds = entries
                .map((entry) => entry.pizzaId)
                .filter((id) => ObjectId.isValid(id))
                .map((id) => new ObjectId(id));

            if (pizzaIds.length === 0) {
                return res.status(200).json([]);
            }

            const pizzas = await menuItems
                .find({
                    _id: { $in: pizzaIds },
                    status: "approved",
                    isActive: true,
                })
                .toArray();

            const pizzasById = new Map(
                pizzas.map((pizza) => [pizza._id.toString(), pizza])
            );

            const items = entries
                .map((entry) => pizzasById.get(String(entry.pizzaId)))
                .filter(Boolean);

            res.status(200).json(items);
        } catch (error) {
            console.error("Wishlist fetch error:", error.message);

            res.status(500).json({
                message: "Failed to fetch wishlist",
            });
        }
    });

    router.post("/", requireAuth, async (req, res) => {
        try {
            const { pizzaId } = req.body ?? {};

            if (!isValidId(pizzaId)) {
                return res.status(400).json({
                    message: "Invalid pizza ID",
                });
            }

            const pizza = await menuItems.findOne({
                _id: new ObjectId(pizzaId),
                status: "approved",
                isActive: true,
            });

            if (!pizza) {
                return res.status(404).json({
                    message: "Pizza is unavailable",
                });
            }

            await wishlist.updateOne(
                {
                    customerId: req.user.id,
                    pizzaId: new ObjectId(pizzaId),
                },
                {
                    $setOnInsert: {
                        customerId: req.user.id,
                        pizzaId: new ObjectId(pizzaId),
                        createdAt: new Date(),
                    },
                },
                { upsert: true }
            );

            res.status(200).json({
                message: "Added to wishlist",
            });
        } catch (error) {
            console.error("Add to wishlist error:", error.message);

            res.status(500).json({
                message: "Failed to add to wishlist",
            });
        }
    });

    router.delete("/:pizzaId", requireAuth, async (req, res) => {
        try {
            const { pizzaId } = req.params;

            if (!isValidId(pizzaId)) {
                return res.status(400).json({
                    message: "Invalid pizza ID",
                });
            }

            await wishlist.deleteOne({
                customerId: req.user.id,
                pizzaId: new ObjectId(pizzaId),
            });

            res.status(200).json({
                message: "Removed from wishlist",
            });
        } catch (error) {
            console.error("Remove from wishlist error:", error.message);

            res.status(500).json({
                message: "Failed to remove from wishlist",
            });
        }
    });

    return router;
}
