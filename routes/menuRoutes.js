import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { withVendorItemLimit } from "../services/vendorItemLimit.js";
import { isPremium } from "../services/premiumStatus.js";
import {
    NOT_DELETED_FILTER,
    PUBLIC_MENU_FILTER,
} from "../utils/menuFilters.js";
import {
    normalizeMenuImages,
    withMenuImages,
} from "../utils/menuImages.js";

const CATEGORY_ALIASES = {
    // Legacy menu items used the longer gourmet label. The UI now uses one
    // canonical category while queries still find older documents.
    "Specialty Pizzas": ["Specialty Pizzas", "Specialty / Gourmet Pizzas"],
};

const firstQueryValue = (value) => {
    if (Array.isArray(value)) {
        return firstQueryValue(value[0]);
    }

    return typeof value === "string" ? value : null;
};

const escapeRegex = (value) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parsePrice = (value) => {
    const raw = firstQueryValue(value);

    if (raw === null || raw.trim() === "") {
        return null;
    }

    const parsed = Number(raw);

    return Number.isFinite(parsed) ? parsed : null;
};

const getMenuSort = (value) => {
    switch (firstQueryValue(value)?.toLowerCase()) {
        case "low":
        case "asc":
        case "price_asc":
            return { price: 1, createdAt: -1 };
        case "high":
        case "desc":
        case "price_desc":
            return { price: -1, createdAt: -1 };
        case "newest":
            return { createdAt: -1 };
        default:
            return { isFeatured: -1, createdAt: -1 };
    }
};

export default function createMenuRoutes(menuCollection, auth, db, client) {
    const router = Router();
    const usersCollection = db.collection("user");

    const attachVendorPlan = async (items) => {
        const list = Array.isArray(items) ? items : [items];
        const vendorIds = [
            ...new Set(
                list
                    .map((item) => item?.vendorId)
                    .filter((id) => id != null && ObjectId.isValid(id))
                    .map((id) => String(id))
            ),
        ];

        const premiumByVendor = new Map();

        await Promise.all(
            vendorIds.map(async (vendorId) => {
                const vendor = await usersCollection.findOne(
                    { _id: new ObjectId(vendorId) },
                    {
                        projection: {
                            plan: 1,
                            isPremium: 1,
                            premiumExpiresAt: 1,
                        },
                    }
                );

                premiumByVendor.set(vendorId, isPremium(vendor));
            })
        );

        const decorate = (item) => {
            if (!item || typeof item !== "object") {
                return item;
            }

            const vendorIsPremium =
                premiumByVendor.get(String(item.vendorId)) ?? false;

            return withMenuImages({
                ...item,
                vendorIsPremium,
                vendorPlan: vendorIsPremium ? "premium" : "free",
            });
        };

        return Array.isArray(items)
            ? items.map(decorate)
            : decorate(items);
    };

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

            const user = await db.collection("user").findOne({
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

            return next();
        } catch (error) {
            console.error("Menu authorization error:", error.message);

            return res.status(500).json({
                message: "Unable to verify permission",
            });
        }
    };

    router.get("/", async (req, res) => {
        try {
            const query = { ...PUBLIC_MENU_FILTER };

            const search =
                firstQueryValue(req.query.search) ??
                firstQueryValue(req.query.q);
            const trimmedSearch = search?.trim();

            if (trimmedSearch) {
                query.name = {
                    $regex: escapeRegex(trimmedSearch),
                    $options: "i",
                };
            }

            const category = firstQueryValue(req.query.category);

            if (category && category !== "All Categories") {
                query.category = CATEGORY_ALIASES[category]
                    ? { $in: CATEGORY_ALIASES[category] }
                    : category;
            }

            const location = firstQueryValue(req.query.location);

            if (location && location !== "All Locations") {
                query.location = location;
            }

            const minPrice =
                parsePrice(req.query.minPrice) ??
                parsePrice(req.query.priceMin);
            const maxPrice =
                parsePrice(req.query.maxPrice) ??
                parsePrice(req.query.priceMax);

            if (minPrice !== null || maxPrice !== null) {
                query.price = {};

                if (minPrice !== null) {
                    query.price.$gte = minPrice;
                }

                if (maxPrice !== null) {
                    query.price.$lte = maxPrice;
                }
            }

            const items = await menuCollection
                .find(query)
                .sort(getMenuSort(req.query.sort))
                .toArray();

            res.status(200).json(await attachVendorPlan(items));
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
                images,
            } = req.body ?? {};

            const imageResult = normalizeMenuImages({ image, images });

            if (
                ![name, description, category, location].every(isValidText) ||
                !imageResult.ok ||
                typeof price !== "number" ||
                !Number.isFinite(price) ||
                price <= 0
            ) {
                return res.status(400).json({
                    message: imageResult.ok
                        ? "Valid menu item information is required"
                        : imageResult.message,
                });
            }

            const newItem = {
                name: name.trim(),
                description: description.trim(),
                category: category.trim(),
                price,
                location: location.trim(),
                image: imageResult.images[0],
                images: imageResult.images,

                vendorId: req.user.id,
                vendor: req.user.name,

                status: "pending",
                isActive: false,
                adminPublished: true,
                isFeatured: false,
                isDeleted: false,
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
                .find({ ...NOT_DELETED_FILTER, vendorId: req.user.id })
                .sort({ createdAt: -1 })
                .toArray();

            res.status(200).json(items.map(withMenuImages));
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

            const baseQuery = { ...PUBLIC_MENU_FILTER };

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

            res.status(200).json(await attachVendorPlan(items));
        } catch (error) {
            console.error("Featured menu fetch error:", error.message);

            res.status(500).json({
                message: "Failed to fetch featured pizzas",
            });
        }
    });

    router.get("/:id", requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            if (!isValidId(id)) {
                return res.status(400).json({
                    message: "Invalid menu item ID",
                });
            }

            const item = await menuCollection.findOne({
                ...PUBLIC_MENU_FILTER,
                _id: new ObjectId(id),
            });

            if (!item) {
                return res.status(404).json({
                    message: "Menu item not found",
                });
            }

            res.status(200).json(await attachVendorPlan(item));
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
                ...NOT_DELETED_FILTER,
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
                ...NOT_DELETED_FILTER,
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
            ];
            const hasImageUpdate =
                Object.prototype.hasOwnProperty.call(body, "image") ||
                Object.prototype.hasOwnProperty.call(body, "images");

            const hasFeaturedUpdate = Object.prototype.hasOwnProperty.call(
                body,
                "isFeatured"
            );
            const hasOtherUpdates =
                hasImageUpdate ||
                editableFields.some((key) =>
                    Object.prototype.hasOwnProperty.call(body, key)
                );

            if (!hasFeaturedUpdate && !hasOtherUpdates) {
                return res.status(400).json({
                    message: "No valid fields provided for update",
                });
            }

            if (hasFeaturedUpdate) {
                if (!isPremium(req.user)) {
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

            if (hasImageUpdate) {
                const imageResult = normalizeMenuImages(body);

                if (!imageResult.ok) {
                    return res.status(400).json({
                        message: imageResult.message,
                    });
                }

                updates.image = imageResult.images[0];
                updates.images = imageResult.images;
            }

            if (hasFeaturedUpdate) {
                updates.isFeatured = body.isFeatured;
            }

            for (const [key, value] of Object.entries(updates)) {
                if (key === "isFeatured" || key === "image" || key === "images") {
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
                    ...NOT_DELETED_FILTER,
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

            const filter = {
                ...NOT_DELETED_FILTER,
                _id: new ObjectId(id),
                vendorId: req.user.id,
            };

            const pizza = await menuCollection.findOne(filter);

            if (!pizza) {
                return res.status(404).json({
                    message: "Pizza not found or not owned by you",
                });
            }

            const result = await menuCollection.updateOne(filter, {
                $set: {
                    isActive: false,
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
