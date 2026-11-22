import { Router } from "express";
import { ObjectId } from "mongodb";
import { fromNodeHeaders } from "better-auth/node";
import { isValidObjectId, validateReviewInput } from "../utils/validators.js";

const EMPTY_REVIEW_SUMMARY = {
    averageRating: 0,
    reviewCount: 0,
    reviews: [],
};

const isDuplicateKeyError = (error) =>
    error?.code === 11000 ||
    error?.code === 11001 ||
    /E11000 duplicate key/i.test(error?.message ?? "");

export default function createReviewRoutes(db, auth) {
    const router = Router();

    const reviews = db.collection("reviews");
    const menuItems = db.collection("menuItems");
    const users = db.collection("user");

    // Optional auth for the public summary, so a signed-in customer can be
    // told they already reviewed without making the endpoint private.
    const getViewerCustomerId = async (req) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });

            if (!session?.user || !ObjectId.isValid(session.user.id)) {
                return null;
            }

            const user = await users.findOne({
                _id: new ObjectId(session.user.id),
            });

            if (!user || user.blocked === true || user.role !== "customer") {
                return null;
            }

            return session.user.id;
        } catch {
            return null;
        }
    };

    // One review per customer per pizza, including under concurrent requests.
    reviews
        .createIndex(
            { customerId: 1, pizzaId: 1 },
            { unique: true, name: "customerId_1_pizzaId_1" }
        )
        .catch((error) =>
            console.error("Reviews index error:", error.message)
        );

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
                name: session.user.name,
                email: session.user.email,
                ...user,
                id: session.user.id,
            };

            next();
        } catch (error) {
            console.error("Review auth error:", error.message);

            return res.status(500).json({
                message: "Unable to verify permission",
            });
        }
    };

    // Public: aggregate ratings for an approved, active pizza.
    router.get("/:pizzaId", async (req, res) => {
        try {
            const { pizzaId } = req.params;

            if (!isValidObjectId(pizzaId)) {
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
                return res.status(200).json(EMPTY_REVIEW_SUMMARY);
            }

            const docs = await reviews
                .find({ pizzaId: pizza._id })
                .sort({ createdAt: -1 })
                .toArray();

            const reviewCount = docs.length;
            const total = docs.reduce(
                (sum, review) => sum + (Number(review.rating) || 0),
                0
            );
            const averageRating =
                reviewCount === 0
                    ? 0
                    : Number((total / reviewCount).toFixed(1));

            const viewerCustomerId = await getViewerCustomerId(req);
            const hasReviewed = viewerCustomerId
                ? docs.some(
                      (review) =>
                          String(review.customerId ?? "") === viewerCustomerId
                  )
                : false;

            return res.status(200).json({
                averageRating,
                reviewCount,
                hasReviewed,
                reviews: docs.map((review) => ({
                    id: review._id.toString(),
                    customerName: review.customerName ?? "",
                    rating: review.rating,
                    comment: review.comment,
                    createdAt: review.createdAt ?? null,
                })),
            });
        } catch (error) {
            console.error("Reviews fetch error:", error.message);

            return res.status(500).json({
                message: "Failed to fetch reviews",
            });
        }
    });

    router.post("/", requireAuth, async (req, res) => {
        try {
            if (req.user.role !== "customer") {
                return res.status(403).json({
                    message: "Only customers can submit reviews",
                });
            }

            const validation = validateReviewInput(req.body ?? {});

            if (!validation.ok) {
                return res.status(400).json({ message: validation.message });
            }

            const { pizzaId, rating, comment } = validation.value;
            const pizzaObjectId = new ObjectId(pizzaId);

            const pizza = await menuItems.findOne({
                _id: pizzaObjectId,
                status: "approved",
                isActive: true,
            });

            if (!pizza) {
                return res.status(404).json({
                    message: "Pizza is unavailable",
                });
            }

            const customerId = req.user.id;

            const existing = await reviews.findOne({
                customerId,
                pizzaId: pizzaObjectId,
            });

            if (existing) {
                return res.status(409).json({
                    message: "You already reviewed this pizza",
                });
            }

            const now = new Date();

            const result = await reviews.insertOne({
                customerId,
                pizzaId: pizzaObjectId,
                pizzaName: pizza.name ?? "",
                // Snapshotted so reviews remain readable if the user changes.
                customerName: req.user.name ?? "",
                customerEmail: req.user.email ?? "",
                rating,
                comment,
                createdAt: now,
                updatedAt: now,
            });

            return res.status(201).json({
                message: "Review submitted successfully",
                insertedId: result.insertedId,
            });
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                return res.status(409).json({
                    message: "You already reviewed this pizza",
                });
            }

            console.error("Review creation error:", error.message);

            return res.status(500).json({
                message: "Failed to submit review",
            });
        }
    });

    return router;
}
