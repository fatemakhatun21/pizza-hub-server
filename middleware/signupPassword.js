import express from "express";

export const PASSWORD_RULE_MESSAGE =
    "Password must be at least 6 characters and include one uppercase and one lowercase letter.";

export function validatePasswordStrength(password) {
    if (typeof password !== "string") {
        return {
            ok: false,
            message: PASSWORD_RULE_MESSAGE,
        };
    }

    if (
        password.length < 6 ||
        !/[A-Z]/.test(password) ||
        !/[a-z]/.test(password)
    ) {
        return {
            ok: false,
            message: PASSWORD_RULE_MESSAGE,
        };
    }

    return { ok: true };
}

const parseSignupBody = express.raw({
    type: [
        "application/json",
        "application/*+json",
        "application/x-www-form-urlencoded",
    ],
    limit: "32kb",
});

/**
 * Better Auth reads the raw Node request itself. This middleware buffers only
 * the public email sign-up request so the password rule can be enforced before
 * Better Auth hashes/stores it, then exposes a parsed object that Better Auth's
 * Node adapter re-serializes into its Request body.
 */
export function readSignupBody(req, res, next) {
    parseSignupBody(req, res, (error) => {
        if (error) {
            return res.status(error.status ?? 400).json({
                message:
                    error.status === 413
                        ? "Request body is too large"
                        : "Invalid request body",
            });
        }

        const contentType = String(req.headers["content-type"] || "");
        const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

        try {
            if (!raw) {
                req.body = {};
            } else if (contentType.startsWith("application/x-www-form-urlencoded")) {
                req.body = Object.fromEntries(new URLSearchParams(raw));
            } else {
                const parsed = JSON.parse(raw);

                if (
                    !parsed ||
                    typeof parsed !== "object" ||
                    Array.isArray(parsed)
                ) {
                    throw new Error("Invalid body shape");
                }

                req.body = parsed;
            }
        } catch {
            return res.status(400).json({ message: "Invalid request body" });
        }

        return next();
    });
}

export function requireStrongSignupPassword(req, res, next) {
    const result = validatePasswordStrength(req.body?.password);

    if (!result.ok) {
        return res.status(400).json({ message: result.message });
    }

    return next();
}
