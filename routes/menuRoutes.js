import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { withVendorItemLimit } from "../services/vendorItemLimit.js";

export default function createMenuRoutes(menuCollection, auth, db, client) {
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

            if (!user || user.role !== "vendor" || user.blocked === true) {
                return res.status(403).json({
                    message: "Only vendors can manage menu items",
                });
            }

            req.user = {
                ...user,
                id: session.user.id,
            };
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
                .sort({ isFeatured: -1, createdAt: -1 })
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
                isFeatured: false,
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

    router.get("/featured", async (req, res) => {
        try {
            const parsedLimit = Number.parseInt(req.query.limit, 10);
            const limit =
                Number.isFinite(parsedLimit) && parsedLimit > 0
                    ? Math.min(parsedLimit, 12)
                    : 6;

            const baseQuery = {
                status: "approved",
                isActive: true,
            };

            const featured = await menuCollection
                .find({
                    ...baseQuery,
                    isFeatured: true,
                })
                .sort({ createdAt: -1 })
                .limit(limit)
                .toArray();

            let items = featured;

            if (featured.length < limit) {
                const fillers = await menuCollection
                    .find({
                        ...baseQuery,
                        _id: { $nin: featured.map((item) => item._id) },
                    })
                    .sort({ createdAt: -1 })
                    .limit(limit - featured.length)
                    .toArray();

                items = [...featured, ...fillers];
            }

            res.status(200).json(items);
        } catch (error) {
            console.error("Featured menu fetch error:", error.message);

            res.status(500).json({
                message: "Failed to fetch featured pizzas",
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


    router.patch("/:id/availability", requireVendor, async (req, res) => {
        try {
            const { id } = req.params;
            const { isActive } = req.body ?? {};

            if (!isValidId(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            if (typeof isActive !== "boolean") {
                return res.status(400).json({
                    message: "isActive must be true or false",
                });
            }

            const filter = {
                _id: new ObjectId(id),
                vendorId: req.user.id,
                status: "approved",
            };

            const pizza = await menuCollection.findOne(filter);

            if (!pizza) {
                return res.status(404).json({
                    message: "Approved pizza not found or not owned by you",
                });
            }

            if (pizza.isActive === isActive) {
                return res.status(200).json({
                    message: "Pizza availability is already up to date",
                    isActive,
                });
            }

            const outcome = await withVendorItemLimit({
                client,
                db,
                vendorId: req.user.id,
                activating: isActive,
                mutate: async ({ session }) => {
                    const result = await menuCollection.updateOne(
                        {
                            ...filter,
                            isActive: !isActive,
                        },
                        {
                            $set: {
                                isActive,
                                updatedAt: new Date(),
                            },
                        },
                        { session }
                    );

                    return result.matchedCount
                        ? {
                            status: 200,
                            message: isActive
                                ? "Pizza is now available"
                                : "Pizza is now unavailable",
                            isActive,
                        }
                        : {
                            status: 409,
                            message: "Pizza availability changed. Please refresh.",
                        };
                },
            });

            return res.status(outcome.status).json(outcome);
        } catch (error) {
            console.error("Availability update error:", error.message);

            return res.status(500).json({
                message: "Failed to update availability",
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

            if (String(existingItem.vendorId) !== String(req.user.id)) {
                return res.status(403).json({
                    message: "You can only edit your own pizzas",
                });
            }
            const body = req.body ?? {};
            const editableFields = [
                "name",
                "description",
                "category",
                "price",
                "location",
                "image",
            ];

            const hasFeaturedUpdate = Object.prototype.hasOwnProperty.call(
                body,
                "isFeatured"
            );
            const hasOtherUpdates = editableFields.some((key) =>
                Object.prototype.hasOwnProperty.call(body, key)
            );

            if (!hasFeaturedUpdate && !hasOtherUpdates) {
                return res.status(400).json({
                    message: "No valid fields provided for update",
                });
            }

            if (hasFeaturedUpdate) {
                if (req.user.plan !== "premium") {
                    return res.status(403).json({
                        message: "Only premium vendors can feature pizzas",
                    });
                }

                if (typeof body.isFeatured !== "boolean") {
                    return res.status(400).json({
                        message: "isFeatured must be true or false",
                    });
                }
            }

            const updates = {};

            for (const key of editableFields) {
                if (Object.prototype.hasOwnProperty.call(body, key)) {
                    updates[key] = body[key];
                }
            }

            if (hasFeaturedUpdate) {
                updates.isFeatured = body.isFeatured;
            }

            for (const [key, value] of Object.entries(updates)) {
                if (key === "isFeatured") {
                    continue;
                }

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

            if (hasOtherUpdates) {
                updates.status = "pending";
                updates.isActive = false;
            }

            updates.updatedAt = new Date();

            const result = await menuCollection.updateOne(
                {
                    _id: new ObjectId(id),
                    vendorId: req.user.id,
                },
                {
                    $set: updates,
                }
            );

            if (result.matchedCount === 0) {
                return res.status(403).json({
                    message: "You can only edit your own pizzas",
                });
            }

            res.status(200).json({
                message: hasOtherUpdates
                    ? "Pizza updated and submitted for approval"
                    : "Featured status updated successfully",
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
