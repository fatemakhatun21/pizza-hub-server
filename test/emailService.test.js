import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    buildOrderStatusEmail,
    isEmailConfigured,
    sendOrderStatusEmail,
} from "../services/emailService.js";

const envKeys = ["RESEND_API_KEY", "EMAIL_FROM", "CLIENT_URL"];
const originalEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]])
);
const originalFetch = global.fetch;

beforeEach(() => {
    for (const key of envKeys) {
        delete process.env[key];
    }

    global.fetch = () => {
        throw new Error("fetch must not be called");
    };
});

afterEach(() => {
    for (const key of envKeys) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }

    global.fetch = originalFetch;
});

const orderDetails = {
    customerName: "Ana",
    pizzaName: "Margherita",
    status: "accepted",
    orderId: "order-123",
    clientUrl: "https://pizzahub.example",
};

test("buildOrderStatusEmail returns subject, text and html for accepted and rejected", () => {
    const accepted = buildOrderStatusEmail(orderDetails);
    const rejected = buildOrderStatusEmail({
        ...orderDetails,
        status: "rejected",
    });

    assert.match(accepted.subject, /accepted/i);
    assert.match(accepted.text, /Ana/);
    assert.match(accepted.text, /Margherita/);
    assert.match(
        accepted.text,
        /https:\/\/pizzahub\.example\/customer\/dashboard\?orderId=order-123/
    );
    assert.match(accepted.html, /<a href=/);

    assert.match(rejected.subject, /order/i);
    assert.match(rejected.text, /rejected/i);
    assert.notEqual(accepted.subject, rejected.subject);

    assert.equal(buildOrderStatusEmail({ ...orderDetails, status: "preparing" }), null);
});

test("buildOrderStatusEmail escapes user-provided values in html", () => {
    const email = buildOrderStatusEmail({
        ...orderDetails,
        customerName: "<script>alert('x')</script>",
    });

    assert.ok(!email.html.includes("<script>"));
    assert.ok(email.html.includes("&lt;script&gt;"));
});

test("no Resend request is made without credentials", async () => {
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        return { ok: true, status: 200 };
    };

    assert.equal(isEmailConfigured(), false);

    const result = await sendOrderStatusEmail({
        to: "ana@example.com",
        ...orderDetails,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "not_configured");
    assert.equal(calls, 0);
});

test("configured credentials produce one correctly addressed Resend request", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "PizzaHub <orders@pizzahub.example>";

    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200 };
    };

    assert.equal(isEmailConfigured(), true);

    const result = await sendOrderStatusEmail({
        to: "ana@example.com",
        ...orderDetails,
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(
        calls[0].options.headers.Authorization,
        "Bearer test-key"
    );

    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.from, "PizzaHub <orders@pizzahub.example>");
    assert.deepEqual(payload.to, ["ana@example.com"]);
    assert.match(payload.subject, /accepted/i);
    assert.ok(payload.text);
    assert.ok(payload.html);
});

test("a provider failure returns a non-throwing failure result", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "PizzaHub <orders@pizzahub.example>";

    global.fetch = async () => ({ ok: false, status: 429 });

    const result = await sendOrderStatusEmail({
        to: "ana@example.com",
        ...orderDetails,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.reason, "provider_error");
    assert.equal(result.status, 429);
    assert.ok(!("body" in result));
});

test("a fetch exception returns a non-throwing failure result", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "PizzaHub <orders@pizzahub.example>";

    global.fetch = async () => {
        throw new Error("network down");
    };

    const result = await sendOrderStatusEmail({
        to: "ana@example.com",
        ...orderDetails,
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.reason, "request_failed");
});
