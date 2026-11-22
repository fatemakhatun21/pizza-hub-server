import test from "node:test";
import assert from "node:assert/strict";
import {
    MAX_REVIEW_COMMENT_LENGTH,
    isValidObjectId,
    isValidRating,
    normalizeReviewComment,
    validateReviewInput,
} from "../utils/validators.js";

const validPizzaId = "507f1f77bcf86cd799439011";

test("pizzaId validator rejects invalid shapes", () => {
    assert.equal(isValidObjectId(validPizzaId), true);
    assert.equal(isValidObjectId(validPizzaId.toUpperCase()), true);

    for (const bad of [
        undefined,
        null,
        "",
        123,
        {},
        [],
        "123",
        "abcdefghijkl",
        validPizzaId.slice(0, 23),
        `${validPizzaId}z`,
    ]) {
        assert.equal(isValidObjectId(bad), false, `accepted ${String(bad)}`);
    }
});

test("rating validator only accepts integers from 1 to 5", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
        assert.equal(isValidRating(rating), true);
    }

    for (const rating of [0, 6, -1, 1.5, "5", null, undefined, NaN, true, Infinity]) {
        assert.equal(isValidRating(rating), false, `accepted ${String(rating)}`);
    }
});

test("comment validator trims and enforces non-empty and max length", () => {
    assert.equal(normalizeReviewComment("  Great pizza  "), "Great pizza");
    assert.equal(normalizeReviewComment("x".repeat(MAX_REVIEW_COMMENT_LENGTH)).length, MAX_REVIEW_COMMENT_LENGTH);

    for (const bad of [
        "",
        "   ",
        null,
        undefined,
        42,
        ["comment"],
        "x".repeat(MAX_REVIEW_COMMENT_LENGTH + 1),
    ]) {
        assert.equal(normalizeReviewComment(bad), null);
    }
});

test("validateReviewInput accepts valid input and rejects bad fields", () => {
    assert.deepEqual(
        validateReviewInput({
            pizzaId: validPizzaId,
            rating: 5,
            comment: "  Delicious  ",
        }),
        {
            ok: true,
            value: {
                pizzaId: validPizzaId,
                rating: 5,
                comment: "Delicious",
            },
        }
    );

    assert.equal(
        validateReviewInput({ pizzaId: "bad", rating: 5, comment: "Nice" }).ok,
        false
    );
    assert.equal(
        validateReviewInput({ pizzaId: validPizzaId, rating: 0, comment: "Nice" }).ok,
        false
    );
    assert.equal(
        validateReviewInput({ pizzaId: validPizzaId, rating: "5", comment: "Nice" }).ok,
        false
    );
    assert.equal(
        validateReviewInput({ pizzaId: validPizzaId, rating: 4, comment: "  " }).ok,
        false
    );
    assert.equal(
        validateReviewInput({
            pizzaId: validPizzaId,
            rating: 4,
            comment: "x".repeat(MAX_REVIEW_COMMENT_LENGTH + 1),
        }).ok,
        false
    );
    assert.equal(validateReviewInput(null).ok, false);
});
