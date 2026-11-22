import { jwt } from "better-auth/plugins";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

export const AUTH_BASE_PATH = "/api/auth";

export function getJWTVerificationConfig() {
    // Better Auth normalizes options.baseURL to its origin before the JWT
    // plugin signs tokens, so iss/aud are the origin (not the raw env value).
    const configuredURL = process.env.BETTER_AUTH_URL;

    if (!configuredURL) {
        throw new Error("BETTER_AUTH_URL is required for JWT verification");
    }

    let baseURL;
    try {
        baseURL = new URL(configuredURL).origin;
    } catch {
        throw new Error("BETTER_AUTH_URL must be a valid URL");
    }

    return {
        jwksUrl: `${baseURL}${AUTH_BASE_PATH}/jwks`,
        issuer: baseURL,
        audience: baseURL,
    };
}

const normalizeOrigin = (value) => {
    if (typeof value !== "string") {
        return null;
    }

    const origin = value.trim();

    if (!origin) {
        return null;
    }

    try {
        return new URL(origin).origin;
    } catch {
        return origin.replace(/\/$/, "");
    }
};

export function getTrustedOrigins() {
    const configured = [
        process.env.CLIENT_URL,
        ...(process.env.CORS_ORIGINS ?? "").split(","),
    ];

    const origins = configured
        .map(normalizeOrigin)
        .filter(Boolean);

    if (process.env.NODE_ENV !== "production") {
        origins.push("http://localhost:3000");
    }

    return [...new Set(origins)];
}

export function createAuth(db, client) {
    return betterAuth({
        plugins: [
            jwt(),
        ],
        database: mongodbAdapter(db, {
            client,
        }),

        baseURL: process.env.BETTER_AUTH_URL,
        basePath: AUTH_BASE_PATH,
        secret: process.env.BETTER_AUTH_SECRET,

        trustedOrigins: getTrustedOrigins(),

        databaseHooks: {
            user: {
                create: {
                    async before(user) {
                        return {
                            data: {
                                ...user,
                                role: "customer",
                                blocked: false,
                            },
                        };
                    },
                },
            },
        },

        user: {
            additionalFields: {
                role: {
                    type: "string",
                    required: false,
                    defaultValue: "customer",
                    input: false,
                },
            },
        },

        emailAndPassword: {
            enabled: true,
            minPasswordLength: 6,
        },

        socialProviders: {
            google: {
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
        },
    });
}
