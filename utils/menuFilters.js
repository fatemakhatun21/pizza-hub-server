// Shared filters keep public menu visibility consistent across browsing,
// details, ordering, reviews, and wishlist lookups. Soft-deleted pizzas are
// retained in the database so historical orders and reviews keep a valid
// reference, but they never appear as purchasable menu items.
export const PUBLIC_MENU_FILTER = {
    status: "approved",
    // Vendor-owned availability.
    isActive: true,
    // Admin-owned visibility. Missing means visible for legacy documents.
    adminPublished: { $ne: false },
    isDeleted: { $ne: true },
};

export const NOT_DELETED_FILTER = {
    isDeleted: { $ne: true },
};

export const isSoftDeleted = (document) => Boolean(document?.isDeleted);
