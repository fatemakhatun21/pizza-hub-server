export const MAX_MENU_IMAGES = 5;

const isHttpUrl = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
};

/**
 * Accepts both the legacy single `image` field and the newer `images` array.
 * The first image is always mirrored into `image` so deployed consumers keep
 * working while details pages can render a gallery.
 */
export function normalizeMenuImages(body = {}) {
    const candidates = [];

    const push = (value) => {
        if (typeof value === "string" && value.trim()) {
            candidates.push(value.trim());
        }
    };

    if (Array.isArray(body.images)) {
        body.images.forEach(push);
    } else {
        push(body.images);
    }

    push(body.image);

    const images = [];

    for (const candidate of candidates) {
        if (!isHttpUrl(candidate)) {
            return {
                ok: false,
                message: "Images must be valid http or https URLs",
            };
        }

        if (!images.includes(candidate)) {
            images.push(candidate);
        }
    }

    if (images.length === 0) {
        return {
            ok: false,
            message: "At least one pizza image is required",
        };
    }

    if (images.length > MAX_MENU_IMAGES) {
        return {
            ok: false,
            message: `A pizza can have at most ${MAX_MENU_IMAGES} images`,
        };
    }

    return { ok: true, images };
}

export function withMenuImages(item) {
    if (!item || typeof item !== "object") {
        return item;
    }

    const images = Array.isArray(item.images)
        ? item.images.filter((value) => typeof value === "string" && value)
        : [];
    const legacyImage =
        typeof item.image === "string" && item.image ? [item.image] : [];
    const combined = [...new Set([...images, ...legacyImage])];

    return {
        ...item,
        images: combined.length ? combined : [],
        image: combined[0] ?? item.image ?? null,
    };
}
