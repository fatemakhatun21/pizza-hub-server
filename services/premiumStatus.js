/**
 * Premium access helper.
 *
 * Legacy premium users have no premiumExpiresAt, so they keep the existing
 * permanent-premium behavior. When an expiry timestamp is present, access
 * ends automatically once that time has passed. Gates read this helper so
 * webhook metadata cannot be bypassed by stale plan strings.
 */
export function isPremium(user, now = new Date()) {
    if (user?.plan !== "premium" && user?.isPremium !== true) {
        return false;
    }

    const expiresAt = user?.premiumExpiresAt;

    if (!expiresAt) {
        return true;
    }

    const expiryTime = new Date(expiresAt).getTime();

    if (Number.isNaN(expiryTime)) {
        return true;
    }

    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();

    if (Number.isNaN(nowTime)) {
        return true;
    }

    return nowTime < expiryTime;
}

export function getPremiumExpiryDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}
