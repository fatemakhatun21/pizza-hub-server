import { ObjectId } from "mongodb";

export const MAX_REVIEW_COMMENT_LENGTH = 1000;

/**
 * Accept canonical 24-character hex ObjectId strings (and ObjectId instances).
 * Rejects short/12-byte strings that ObjectId.isValid() would otherwise coerce.
 */
export function isValidObjectId(value) {
    if (value instanceof ObjectId) {
        return true;
    }

    if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) {
        return false;
    }

    return (
        ObjectId.isValid(value) &&
        String(new ObjectId(value)) === value.toLowerCase()
    );
}

export function isValidRating(value) {
    return Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Returns the trimmed comment, or null when it is invalid. */
export function normalizeReviewComment(value) {
    if (typeof value !== "string") {
        return null;
    }

    const comment = value.trim();

    if (
        comment.length === 0 ||
        comment.length > MAX_REVIEW_COMMENT_LENGTH
    ) {
        return null;
    }

    return comment;
}

/**
 * Pure validator for POST /api/reviews.
 * Returns { ok: true, value: { pizzaId, rating, comment } } or
 * { ok: false, message }.
 */
export function validateReviewInput(input = {}) {
    const { pizzaId, rating, comment } = input ?? {};

    if (!isValidObjectId(pizzaId)) {
        return { ok: false, message: "Invalid pizza ID" };
    }

    if (!isValidRating(rating)) {
        return {
            ok: false,
            message: "Rating must be an integer between 1 and 5",
        };
    }

    const normalizedComment = normalizeReviewComment(comment);

    if (normalizedComment === null) {
        return {
            ok: false,
            message: `Comment is required and must be at most ${MAX_REVIEW_COMMENT_LENGTH} characters`,
        };
    }

    return {
        ok: true,
        value: {
            pizzaId: String(pizzaId),
            rating,
            comment: normalizedComment,
        },
    };
}
