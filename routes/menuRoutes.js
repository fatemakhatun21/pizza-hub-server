import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";

export default function createMenuRoutes(menuCollection, auth, db) {
    const router = Router();

    const requireVendor = async (req, res, next) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });

            if (!session?.user) {
                return res.status(401).json({
                    message: "Please sign in first",
                });
            }

            const user = await db.collection("user").findOne({
                _id: new ObjectId(session.user.id),
            });

            if (!user || user.role !== "vendor") {
                return res.status(403).json({
                    message: "Only vendors can manage menu items",
                });
            }

            req.user = user;
            next();
        } catch (error) {
            console.error("Authorization error:", error.message);
            res.status(500).json({
                message: "Unable to verify permission",
            });
        }
    };

    const isValidId = (id) =>
        ObjectId.isValid(id) &&
        String(new ObjectId(id)) === id.toLowerCase();

    const isValidText = (value) =>
        typeof value === "string" && value.trim().length > 0;

    router.get("/", async (req, res) => {
        try {
            const items = await menuCollection
                .find({
                    status: "approved",
                    isActive: true,
                })
                .toArray();

            res.status(200).json(items);
        } catch (error) {
            console.error("Menu fetch error:", error.message);
            res.status(500).json({
                message: "Failed to fetch menu items",
            });
        }
    });

    router.post("/", requireVendor, async (req, res) => {
        try {
            const {
                name,
                description,
                category,
                price,
                location,
                image,
            } = req.body ?? {};

            if (
                ![name, description, category, location, image]
                    .every(isValidText) ||
                typeof price !== "number" ||
                !Number.isFinite(price) ||
                price <= 0
            ) {
                return res.status(400).json({
                    message: "Valid menu item information is required",
                });
            }

            const newItem = {
                name: name.trim(),
                description: description.trim(),
                category: category.trim(),
                price,
                location: location.trim(),
                image: image.trim(),

                vendorId: req.user.id,
                vendor: req.user.name,

                status: "pending",
                isActive: false,
                createdAt: new Date(),
            };

            const result = await menuCollection.insertOne(newItem);

            res.status(201).json({
                message: "Menu item submitted for approval",
                insertedId: result.insertedId,
            });
        } catch (error) {
            console.error("Menu creation error:", error.message);
            res.status(500).json({
                message: "Failed to create menu item",
            });
        }
    });


    router.get("/vendor/mine", requireVendor, async (req, res) => {
        try {
            const items = await menuCollection
                .find({ vendorId: req.user.id })
                .sort({ createdAt: -1 })
                .toArray();

            res.status(200).json(items);
        } catch (error) {
            console.error("Vendor menu error:", error.message);

            res.status(500).json({
                message: "Failed to fetch your pizzas",
            });
        }
    });

    router.get("/:id", async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const item = await menuCollection.findOne({
                _id: new ObjectId(id),
                status: "approved",
                isActive: true,
            });

            if (!item) {
                return res.status(404).json({
                    message: "Menu item not found",
                });
            }

            res.status(200).json(item);
        } catch (error) {
            console.error("Single menu fetch error:", error.message);
            res.status(500).json({
                message: "Failed to fetch menu item",
            });
        }
    });

    router.patch("/:id", requireVendor, async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const existingItem = await menuCollection.findOne({
                _id: new ObjectId(id),
            });

            if (!existingItem) {
                return res.status(404).json({
                    message: "Menu item not found",
                });
            }

            if (existingItem.vendorId !== req.user.id) {
                return res.status(403).json({
                    message: "You can only edit your own pizzas",
                });
            }

            const allowedFields = [
                "name",
                "description",
                "category",
                "price",
                "location",
                "image",
            ];

            const updates = Object.fromEntries(
                Object.entries(req.body ?? {}).filter(([key]) =>
                    allowedFields.includes(key)
                )
            );

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    message: "No valid fields provided for update",
                });
            }

            for (const [key, value] of Object.entries(updates)) {
                if (key === "price") {
                    if (
                        typeof value !== "number" ||
                        !Number.isFinite(value) ||
                        value <= 0
                    ) {
                        return res.status(400).json({
                            message: "Price must be a positive number",
                        });
                    }
                } else if (!isValidText(value)) {
                    return res.status(400).json({
                        message: `Invalid value for ${key}`,
                    });
                } else {
                    updates[key] = value.trim();
                }
            }
            const result = await menuCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    vendorId: req.user.id,
                },
                {
                    $set: {
                        ...updates,
                        status: "pending",
                        isActive: false,
                        updatedAt: new Date(),
                    },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(403).json({
                    message: "You can only edit your own pizzas",
                });
            }

            res.status(200).json({
                message: "Pizza updated and submitted for approval",
            });
        } catch (error) {
            console.error("Menu update error:", error.message);
            res.status(500).json({
                message: "Failed to update menu item",
            });
        }
    });

    router.delete("/:id", requireVendor, async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const result = await menuCollection.deleteOne({
                _id: new ObjectId(id),
                vendorId: req.user.id,
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    message: "Pizza not found or not owned by you",
                });
            }

            res.status(200).json({
                message: "Menu item deleted successfully",
            });
        } catch (error) {
            console.error("Menu deletion error:", error.message);
            res.status(500).json({
                message: "Failed to delete menu item",
            });
        }
    });

    return router;
}
