import { Router } from "express";
import { ObjectId } from "mongodb";

export default function createMenuRoutes(menuCollection) {
    const router = Router();

    router.get("/", async (req, res) => {
        try {
            const items = await menuCollection.find().toArray();
            res.status(200).json(items);
        } catch (error) {
            console.error("Menu fetch error:", error.message);
            res.status(500).json({
                message: "Failed to fetch menu items",
            });
        }
    });

    router.post("/", async (req, res) => {
        try {
            const {
                name,
                description,
                category,
                price,
                location,
                vendor,
                image,
            } = req.body;

            if (
                !name?.trim() ||
                !description?.trim() ||
                !category?.trim() ||
                !location?.trim() ||
                !vendor?.trim() ||
                !image?.trim() ||
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
                vendor: vendor.trim(),
                image: image.trim(),
                status: "pending",
                isActive: false,
                createdAt: new Date(),
            };

            const result = await menuCollection.insertOne(newItem);

            res.status(201).json({
                message: "Menu item created successfully",
                insertedId: result.insertedId,
            });
        } catch (error) {
            console.error("Menu creation error:", error.message);
            res.status(500).json({
                message: "Failed to create menu item",
            });
        }
    });

    router.get("/:id", async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const item = await menuCollection.findOne({
                _id: new ObjectId(id),
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

    router.patch("/:id", async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
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
                Object.entries(req.body).filter(([key]) =>
                    allowedFields.includes(key)
                )
            );

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    message: "No valid fields provided for update",
                });
            }

            if (
                updates.price !== undefined &&
                (typeof updates.price !== "number" ||
                    !Number.isFinite(updates.price) ||
                    updates.price <= 0)
            ) {
                return res.status(400).json({
                    message: "Price must be a positive number",
                });
            }

            const result = await menuCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        ...updates,
                        updatedAt: new Date(),
                    },
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({
                    message: "Menu item not found",
                });
            }

            res.status(200).json({
                message: "Menu item updated successfully",
            });
        } catch (error) {
            console.error("Menu update error:", error.message);

            res.status(500).json({
                message: "Failed to update menu item",
            });
        }
    });

    router.delete("/:id", async (req, res) => {
        try {
            const { id } = req.params;

            if (!ObjectId.isValid(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const result = await menuCollection.deleteOne({
                _id: new ObjectId(id),
            });

            if (result.deletedCount === 0) {
                return res.status(404).json({
                    message: "Menu item not found",
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
