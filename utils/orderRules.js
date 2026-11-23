export const ACTIVE_ORDER_STATUSES = ["pending", "accepted", "preparing", "out_for_delivery"];
export const MAX_ORDER_MESSAGE_LENGTH = 500;

/** Returns a stable business-date key while preserving the stored Date value. */
export function getDeliveryDateKey(deliveryDate) {
    const date = new Date(deliveryDate);
    return Number.isNaN(date.getTime())
        ? ""
        : date.toISOString().slice(0, 10);
}

export function normalizeOrderMessage(value) {
    if (value === undefined || value === null || value === "") {
        return { ok: true, value: "" };
    }

    if (typeof value !== "string") {
        return { ok: false, message: "Special instructions must be text" };
    }

    const trimmed = value.trim();

    if (trimmed.length > MAX_ORDER_MESSAGE_LENGTH) {
        return {
            ok: false,
            message: `Special instructions must be ${MAX_ORDER_MESSAGE_LENGTH} characters or fewer`,
        };
    }

    return { ok: true, value: trimmed };
}
