import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";

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
        database: mongodbAdapter(db, {
            client,
        }),

        baseURL: process.env.BETTER_AUTH_URL,
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
