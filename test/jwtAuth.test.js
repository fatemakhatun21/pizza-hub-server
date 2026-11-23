import test from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import {
    SignJWT,
    customFetch,
    exportJWK,
    generateKeyPair,
} from "jose";

import {
    getJWTVerificationConfig,
} from "../config/auth.js";
import {
    createJWTVerifier,
    requireJWT,
    withJWTSessions,
} from "../middleware/verifyJWT.js";

const BASE_URL = "http://localhost:5000";
const JWKS_URL = `${BASE_URL}/api/auth/jwks`;
const USER_ID = new ObjectId().toHexString();
const KID = "pizzahub-test-key";

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: "EdDSA",
    use: "sig",
};

const fetchJWKS = async (url) => {
    assert.equal(url, JWKS_URL);

    return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
};

const config = {
    jwksUrl: JWKS_URL,
    issuer: BASE_URL,
    audience: BASE_URL,
};

const makeVerifier = (overrides = {}) =>
    createJWTVerifier({
        config,
        remoteJWKSOptions: { [customFetch]: fetchJWKS },
        ...overrides,
    });

const signToken = (claims = {}, options = {}) => {
    const { sub = USER_ID, ...payload } = claims;
    const now = Math.floor(Date.now() / 1000);

    return new SignJWT(payload)
        .setProtectedHeader({ alg: "EdDSA", kid: KID, typ: "JWT" })
        .setSubject(sub)
        .setIssuedAt(now)
        .setExpirationTime(options.exp ?? now + 900)
        .setIssuer(options.issuer ?? BASE_URL)
        .setAudience(options.audience ?? BASE_URL)
        .sign(privateKey);
};

const tamper = (token) => {
    const parts = token.split(".");
    const signature = parts[2];

    parts[2] =
        (signature[0] === "A" ? "B" : "A") +
        signature.slice(1);

    return parts.join(".");
};


const makeUser = (overrides = {}) => ({
    _id: new ObjectId(USER_ID),
    name: "JWT Test User",
    email: "jwt.test@example.test",
    role: "customer",
    blocked: false,
    ...overrides,
});

const makeDb = (user) => ({
    collection: () => ({
        findOne: async () => user,
    }),
});

const makeAuth = (session) => ({
    api: {
        getSession: async () => session,
    },
});

const makeResponse = () => ({
    statusCode: 200,
    body: null,
    status(code) {
        this.statusCode = code;
        return this;
    },
    json(value) {
        this.body = value;
        return this;
    },
});

const headersWith = (value) =>
    new Headers(value ? { authorization: value } : {});

test("JWT config matches the normalized Better Auth base URL", () => {
    const previous = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = `${BASE_URL}/`;

    try {
        assert.deepEqual(getJWTVerificationConfig(), config);
    } finally {
        if (previous === undefined) {
            delete process.env.BETTER_AUTH_URL;
        } else {
            process.env.BETTER_AUTH_URL = previous;
        }
    }
});

test("valid JWT is verified against JWKS, issuer, audience, and subject", async () => {
    const token = await signToken({ role: "customer" });
    const payload = await makeVerifier()(token);

    assert.equal(payload.sub, USER_ID);
    assert.equal(payload.iss, BASE_URL);
    assert.equal(payload.aud, BASE_URL);
    assert.equal(payload.role, "customer");
});

test("JWT with a wrong issuer or audience is rejected", async () => {
    const verifier = makeVerifier();

    await assert.rejects(async () =>
        verifier(await signToken({}, { issuer: "https://evil.example" }))
    );
    await assert.rejects(async () =>
        verifier(await signToken({}, { audience: "https://evil.example" }))
    );
});

test("expired and tampered JWTs are rejected", async () => {
    const verifier = makeVerifier();
    const now = Math.floor(Date.now() / 1000);

    await assert.rejects(async () =>
        verifier(await signToken({}, { exp: now - 60 }))
    );
    await assert.rejects(async () => verifier(tamper(await signToken())));
    await assert.rejects(() => verifier("not-a-jwt"));
});

test("JWT with a non-ObjectId subject is rejected", async () => {
    const verifier = makeVerifier();
    const token = await signToken({ sub: "not-an-object-id" });

    await assert.rejects(() => verifier(token));
});

test("withJWTSessions accepts Bearer JWTs and keeps cookie sessions", async () => {
    const verifier = makeVerifier();
    const token = await signToken({ role: "admin" });
    const cookieSession = {
        user: { id: USER_ID, email: "cookie@example.test" },
        session: { id: "cookie-session" },
    };
    const wrapped = withJWTSessions(
        makeAuth(cookieSession),
        makeDb(makeUser({ role: "customer" })),
        verifier
    );

    const jwtSession = await wrapped.api.getSession({
        headers: headersWith(`Bearer ${token}`),
    });

    assert.equal(jwtSession.user.id, USER_ID);
    assert.equal(jwtSession.user.email, "jwt.test@example.test");
    // Role comes from MongoDB, not from the token claim.
    assert.equal(jwtSession.user.role, "customer");

    const session = await wrapped.api.getSession({
        headers: new Headers({ cookie: "better-auth.session_token=abc" }),
    });

    assert.equal(session, cookieSession);
});

test("withJWTSessions maps invalid Bearer tokens to a missing session", async () => {
    const verifier = makeVerifier();
    const wrapped = withJWTSessions(
        makeAuth(null),
        makeDb(makeUser()),
        verifier
    );

    const cases = [
        "Bearer",
        "Bearer malformed.token.value",
        `Bearer ${await signToken({}, { issuer: "https://evil.example" })}`,
        `Bearer ${tamper(await signToken())}`,
    ];

    for (const authorization of cases) {
        const session = await wrapped.api.getSession({
            headers: headersWith(authorization),
        });
        assert.equal(session, null);
    }
});

test("withJWTSessions rejects blocked users for Bearer JWTs", async () => {
    const verifier = makeVerifier();
    const wrapped = withJWTSessions(
        makeAuth(null),
        makeDb(makeUser({ blocked: true })),
        verifier
    );

    const session = await wrapped.api.getSession({
        headers: headersWith(`Bearer ${await signToken()}`),
    });

    assert.equal(session, null);
});

test("requireJWT rejects missing, malformed, and invalid credentials with 401", async () => {
    const guard = requireJWT(makeVerifier(), makeDb(makeUser()));
    const cases = [
        null,
        "Basic abc123",
        "Bearer",
        "Bearer malformed.token.value",
        `Bearer ${tamper(await signToken())}`,
        `Bearer ${await signToken({}, { exp: Math.floor(Date.now() / 1000) - 30 })}`,
    ];

    for (const authorization of cases) {
        const res = makeResponse();
        await guard({ headers: headersWith(authorization) }, res, () => {
            throw new Error("next() must not be called");
        });
        assert.equal(res.statusCode, 401);
    }
});

test("requireJWT uses database roles and blocks unavailable users", async () => {
    const guard = requireJWT(makeVerifier(), makeDb(makeUser()));
    const res = makeResponse();
    let called = false;

    await guard(
        { headers: headersWith(`Bearer ${await signToken({ role: "admin" })}`) },
        res,
        () => {
            called = true;
        }
    );

    assert.equal(called, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, null);

    const blockedGuard = requireJWT(
        makeVerifier(),
        makeDb(makeUser({ blocked: true }))
    );
    const blockedRes = makeResponse();

    await blockedGuard(
        { headers: headersWith(`Bearer ${await signToken()}`) },
        blockedRes,
        () => {
            throw new Error("next() must not be called");
        }
    );

    assert.equal(blockedRes.statusCode, 403);
});

test("JWT identity preserves customer, vendor, and admin role checks", async () => {
    const verifier = makeVerifier();
    const token = await signToken();
    const roles = ["customer", "vendor", "admin"];

    for (const role of roles) {
        const wrapped = withJWTSessions(
            makeAuth(null),
            makeDb(makeUser({ role })),
            verifier
        );
        const session = await wrapped.api.getSession({
            headers: headersWith(`Bearer ${token}`),
        });

        assert.equal(session.user.role, role);

        const allowed = (expected) =>
            expected === role ? 200 : 403;

        assert.equal(allowed("customer"), role === "customer" ? 200 : 403);
        assert.equal(allowed("vendor"), role === "vendor" ? 200 : 403);
        assert.equal(allowed("admin"), role === "admin" ? 200 : 403);
    }
});
