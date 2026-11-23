import { ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getJWTVerificationConfig } from "../config/auth.js";

const readAuthorization = (headers) => {
    if (!headers) return null;

    if (typeof headers.get === "function") {
        return headers.get("authorization");
    }

    const key = Object.keys(headers).find(
        (name) => name.toLowerCase() === "authorization"
    );

    return key ? headers[key] : null;
};

const bearerToken = (authorization) => {
    const match = /^Bearer\s+(.+)$/i.exec(String(authorization ?? "").trim());
    return match ? match[1].trim() : null;
};

/**
 * Verifies Better Auth JWTs against the plugin's JWKS endpoint.
 *
 * Issuer, audience and JWKS URL come from the same Better Auth base URL that
 * the server uses when it signs tokens. `jwtVerify` also validates exp/nbf.
 */
export function createJWTVerifier(options = {}) {
    const config = options.config ?? getJWTVerificationConfig();
    const remoteJWKSOptions = options.remoteJWKSOptions ?? {};
    const JWKS = createRemoteJWKSet(new URL(config.jwksUrl), remoteJWKSOptions);

    return async function verifyJWT(token) {
        const { payload } = await jwtVerify(token, JWKS, {
            issuer: config.issuer,
            audience: config.audience,
            clockTolerance: 0,
            ...options.jwtVerifyOptions,
        });

        if (typeof payload.sub !== "string" || !ObjectId.isValid(payload.sub)) {
            throw new Error("Invalid JWT subject");
        }

        return payload;
    };
}

/**
 * Adds Bearer JWT support to the existing Better Auth session middleware.
 *
 * Cookie sessions keep using Better Auth unchanged. When a Bearer token is
 * present it must verify successfully; a bad token becomes a missing session,
 * which every existing guard already answers with HTTP 401. Roles and blocked
 * state are always read from MongoDB, never trusted from token claims.
 */
export function withJWTSessions(auth, db, verifyJWT) {
    const users = db.collection("user");
    const originalGetSession = auth.api.getSession.bind(auth.api);

    return {
        ...auth,
        api: {
            ...auth.api,
            async getSession(options = {}) {
                const authorization = readAuthorization(options.headers);

                if (
                    typeof authorization === "string" &&
                    /^Bearer\b/i.test(authorization.trim())
                ) {
                    const token = bearerToken(authorization);

                    if (!token) return null;

                    try {
                        const payload = await verifyJWT(token);
                        const user = await users.findOne({
                            _id: new ObjectId(payload.sub),
                        });

                        if (!user || user.blocked === true) return null;

                        const id = String(user._id);

                        return {
                            user: {
                                id,
                                name: user.name ?? "",
                                email: user.email ?? "",
                                image: user.image ?? null,
                                role: user.role || "customer",
                                plan: user.plan || "free",
                            },
                            session: {
                                id: payload.jti ?? `jwt-${id}`,
                                userId: id,
                                expires:
                                    typeof payload.exp === "number"
                                        ? new Date(payload.exp * 1000).toISOString()
                                        : null,
                            },
                        };
                    } catch {
                        return null;
                    }
                }

                return originalGetSession(options);
            },
        },
    };
}

/** Strict JWT-only guard for endpoints that must not accept session cookies. */
export function requireJWT(verifyJWT, db) {
    const users = db.collection("user");

    return async (req, res, next) => {
        const token = bearerToken(readAuthorization(req.headers));

        if (!token) {
            return res.status(401).json({ message: "JWT token required" });
        }

        try {
            const payload = await verifyJWT(token);
            const user = await users.findOne({
                _id: new ObjectId(payload.sub),
            });

            if (!user || user.blocked === true) {
                return res.status(403).json({
                    message: "Account unavailable or blocked",
                });
            }

            req.user = { ...user, id: String(user._id) };
            req.dbUser = user;
            req.authMethod = "jwt";

            return next();
        } catch {
            return res.status(401).json({ message: "Invalid or expired JWT" });
        }
    };
}
