const RESEND_ENDPOINT = "https://api.resend.com/emails";
const EMAIL_TIMEOUT_MS = 5000;

const escapeHtml = (value) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

function buildOrderLink(clientUrl, orderId) {
    if (
        typeof clientUrl !== "string" ||
        !clientUrl.trim() ||
        !orderId
    ) {
        return null;
    }

    try {
        const url = new URL(clientUrl);

        if (!["http:", "https:"].includes(url.protocol)) {
            return null;
        }

        return `${url.origin}/customer/dashboard?orderId=${encodeURIComponent(String(orderId))}`;
    } catch {
        return null;
    }
}

/** Pure builder for the two customer-facing order status emails. */
export function buildOrderStatusEmail({
    customerName,
    pizzaName,
    status,
    orderId,
    clientUrl,
} = {}) {
    const templates = {
        accepted: {
            subject: "Your PizzaHub order was accepted",
            message: (pizza) =>
                `Good news! Your order for ${pizza} has been accepted and is being prepared.`,
        },
        rejected: {
            subject: "Update on your PizzaHub order",
            message: (pizza) =>
                `Unfortunately, your order for ${pizza} was rejected by the restaurant. You will not be charged for it.`,
        },
    };

    const template = templates[status];

    if (!template) {
        return null;
    }

    const name = String(customerName ?? "").trim() || "there";
    const pizza = String(pizzaName ?? "").trim() || "your pizza";
    const greeting = `Hi ${name},`;
    const body = template.message(pizza);
    const link = buildOrderLink(clientUrl, orderId);

    const lines = [greeting, "", body];

    if (orderId) {
        lines.push("", `Order ID: ${orderId}`);
    }

    if (link) {
        lines.push("", `View your order: ${link}`);
    }

    lines.push("", "Thanks for ordering with PizzaHub.");

    const linkHtml = link
        ? `<p><a href="${escapeHtml(link)}">View your order</a></p>`
        : "";
    const orderIdHtml = orderId
        ? `<p>Order ID: ${escapeHtml(orderId)}</p>`
        : "";

    return {
        subject: template.subject,
        text: lines.join("\n"),
        html: `<div>
  <p>${escapeHtml(greeting)}</p>
  <p>${escapeHtml(body)}</p>
  ${orderIdHtml}
  ${linkHtml}
  <p>Thanks for ordering with PizzaHub.</p>
</div>`,
    };
}

export function isEmailConfigured() {
    return Boolean(
        typeof process.env.RESEND_API_KEY === "string" &&
            process.env.RESEND_API_KEY.trim() &&
            typeof process.env.EMAIL_FROM === "string" &&
            process.env.EMAIL_FROM.trim()
    );
}

/**
 * Sends an order status email through Resend's REST API using global fetch.
 * Missing configuration or provider failures never throw: callers get a
 * result object describing what happened. Provider response bodies are never
 * logged or returned.
 */
export async function sendOrderStatusEmail({
    to,
    customerName,
    pizzaName,
    status,
    orderId,
    clientUrl,
} = {}) {
    if (!isEmailConfigured()) {
        return { ok: false, skipped: true, reason: "not_configured" };
    }

    const email = buildOrderStatusEmail({
        customerName,
        pizzaName,
        status,
        orderId,
        clientUrl,
    });

    if (!email) {
        return { ok: false, skipped: true, reason: "unsupported_status" };
    }

    if (typeof to !== "string" || !to.trim()) {
        return { ok: false, skipped: true, reason: "missing_recipient" };
    }

    try {
        const response = await fetch(RESEND_ENDPOINT, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY.trim()}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: process.env.EMAIL_FROM.trim(),
                to: [to.trim()],
                subject: email.subject,
                text: email.text,
                html: email.html,
            }),
            signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
        });

        if (!response.ok) {
            return {
                ok: false,
                skipped: false,
                reason: "provider_error",
                status: response.status,
            };
        }

        return { ok: true, skipped: false };
    } catch (error) {
        return {
            ok: false,
            skipped: false,
            reason: "request_failed",
            error: error?.message ?? "Unknown email error",
        };
    }
}
