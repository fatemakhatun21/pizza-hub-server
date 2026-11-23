export function isDuplicateKeyError(error) {
    return (
        error?.code === 11000 ||
        error?.code === 11001 ||
        /E11000 duplicate key/i.test(error?.message ?? "")
    );
}

/**
 * Returns true for a duplicate-key error whose key covers every field in
 * `fields`. Errors without a key pattern are treated as a match so callers
 * can still handle generic MongoDB duplicate errors safely.
 */
export function isDuplicateKeyFor(error, fields = []) {
    if (!isDuplicateKeyError(error)) {
        return false;
    }

    const pattern = error?.keyPattern ?? error?.keyValue;

    if (!pattern || typeof pattern !== "object") {
        return true;
    }

    return fields.every((field) =>
        Object.prototype.hasOwnProperty.call(pattern, field)
    );
}
