
# 🍕 PizzaHub — Backend API

The backend server for **PizzaHub — Pizza Ordering & Delivery Platform**, a full-stack application connecting customers, pizza vendors, and platform administrators.

Built with **Node.js, Express.js, MongoDB Atlas, and Better Auth**, the API manages authentication, menu items, orders, reviews, subscriptions, and administrative operations.

## 🌐 Live Links

- **Frontend:** https://pizza-hub-client-nine.vercel.app
- **Backend:** https://pizza-hub-server.onrender.com
- **Health Check:** https://pizza-hub-server.onrender.com/health

## 🔗 GitHub Repositories

- **Client:** https://github.com/fatemakhatun21/pizza-hub-client
- **Server:** https://github.com/fatemakhatun21/pizza-hub-server

## ✨ Key Features

- Email/password and Google authentication with Better Auth
- Role-based authorization for customers, vendors, and administrators
- JWT support and token verification middleware
- MongoDB-backed user and session management
- Secure menu item CRUD operations for vendors
- ImgBB image uploads through a backend upload endpoint
- Administrative menu approval and rejection
- Customer order creation, tracking, and cancellation
- Vendor order acceptance and rejection
- Duplicate-order prevention and resource ownership checks
- Free and Premium vendor subscription management
- Stripe Checkout integration and webhook-based payment verification
- Customer wishlists, reviews, and ratings
- Order status tracking and email notification integration
- Validation, error handling, and blocked-user restrictions

## 🛠️ Technology Stack

- **Runtime:** Node.js 20.19+
- **Framework:** Express.js 5
- **Database:** MongoDB Atlas
- **Authentication:** Better Auth 1.7 with MongoDB Adapter
- **JWT:** Better Auth JWT Plugin and JOSE
- **Payments:** Stripe
- **Image Upload:** Multer and ImgBB
- **Email Notifications:** Resend API
- **Environment Configuration:** dotenv
- **Testing:** Node.js built-in test runner

## 👥 User Roles

### Customer
Customers can browse approved item lists, place orders, track order statuses, cancel eligible orders, manage wishlists, and submit reviews. Viewing a single item's details requires signing in.

### Vendor
Vendors can manage their own menu items, upload images, control availability, view customer orders, and accept or reject pending orders.

Free vendors are limited to three active menu items. Premium vendors receive unlimited publishing privileges and promotional benefits.

### Admin
Administrators can manage registered users, review submitted menu items, approve or reject listings, and view subscription transactions.

## 🔐 Authentication and Authorization

PizzaHub uses Better Auth for email/password and Google OAuth authentication.

Protected API operations enforce authentication, user roles, account restrictions, and resource ownership.

JWT functionality uses Better Auth's JWT support with JOSE-based verification. Token-protected endpoints validate token signatures and expiration, while authorization checks use the current user record in MongoDB.

**Security principles:**

- Never trust client-provided roles or user IDs for authorization.
- Verify ownership before updating or deleting resources.
- Restrict blocked users from protected operations.
- Reject unauthenticated requests with HTTP 401.
- Reject forbidden operations with HTTP 403.
- Keep API keys and credentials in environment variables.

## 📡 API Endpoints

### System

| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | Server status message |
| GET | `/health` | Health check |

### Authentication and User Profile

| Method | Endpoint | Description |
|---|---|---|
| ALL | `/api/auth/*` | Better Auth endpoints |
| GET | `/api/me` | Get authenticated user profile |
| PATCH | `/api/me` | Update profile information |
| POST | `/api/vendor/register` | Register an authenticated customer as a vendor |

### Menu Items

Menu endpoints are available under `/api/menu`.

| Method | Endpoint | Access | Description |
|---|---|---|---|
| GET | `/api/menu` | Public | Browse approved, active items with search/filter/sort |
| GET | `/api/menu/featured` | Public | Browse featured approved, active items |
| GET | `/api/menu/:id` | Authenticated | View a single approved, active item |
| POST / PATCH / DELETE | `/api/menu/...` | Vendor | Create, edit, delete, or change availability of own items |

Vendor management requires the `vendor` role.

### Orders

Order endpoints are available under:

`/api/orders`

They support customer order creation and cancellation, vendor order management, and order status updates.

### Reviews and Wishlist

- `/api/reviews` — reviews and ratings
- `/api/wishlist` — customer favorites

### Admin

`/api/admin`

Provides role-protected administrative operations for users, menu approvals, statistics, and transactions.

### Billing

`/api/billing`

Manages vendor premium subscriptions and Stripe Checkout.

**Stripe webhook endpoint:**

`POST /api/billing/webhook`

### Image Upload

`/api/uploads`

Supports authenticated image uploads through ImgBB.

## 🔎 Challenge Implementations

### Advanced Search and Sorting

`GET /api/menu` accepts these query parameters:

| Parameter | Example | Purpose |
|---|---|---|
| `search` / `q` | `pepperoni` | Case-insensitive item-name search |
| `category` | `Classic Pizzas` | Category filter; legacy gourmet aliases are translated |
| `location` | `Dhanmondi` | Location filter |
| `minPrice` / `priceMin` | `10` | Minimum price |
| `maxPrice` / `priceMax` | `20` | Maximum price |
| `sort` | `price_asc`, `price_desc`, `newest` | Price sorting or newest-first |

`GET /api/admin/menu` accepts `search`, `status`, `category`, `location`, and `sort` for admin-side filtering. All parameters are normalized server-side and applied only to approved/active public items for the public endpoint.

### JWT Verification

Better Auth's JWT plugin issues tokens. Protected API clients send `Authorization: Bearer <token>`; `createJWTVerifier()` discovers the JWKS from `${BETTER_AUTH_URL}/api/auth/jwks`, then `requireJWT()` verifies the signature, `iss`, `aud`, expiration, and blocked status before loading the current database user. `withJWTSessions()` maps eligible Bearer requests into Better Auth-compatible sessions while browser cookie sessions continue through `/api/me`. Role middleware then returns `401` for unauthenticated requests and `403` for forbidden roles. Invalid, expired, or wrong-issuer tokens never reach route handlers.

### Safe Admin Provisioning

Public registration always forces `role: "customer"`; the role field is not client-writable. After a trusted admin has signed in once, promote that account directly in the database during a controlled maintenance window:

```javascript
const appDb = db.getSiblingDB("pizzahub_db");
appDb.user.updateOne(
  { email: "admin@example.com" },
  { $set: { role: "admin", blocked: false, updatedAt: new Date() } }
);
```

Never create admin accounts from the public registration endpoint, never commit admin credentials, and verify the promoted account through `/api/me` before granting access.

### Professional UI/UX

The backend supports the responsive frontend through structured API responses, consistent error messages, role-based dashboards, loading states, and dynamic database-backed content.

## 💻 Local Installation

### 1. Clone Repository

```bash
git clone https://github.com/fatemakhatun21/pizza-hub-server.git
cd pizza-hub-server
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root.

```env
PORT=5000
NODE_ENV=development

MONGODB_URI=your_mongodb_connection_string

BETTER_AUTH_URL=http://localhost:5000
BETTER_AUTH_SECRET=your_secure_auth_secret

CLIENT_URL=http://localhost:3000

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

IMGBB_API_KEY=your_imgbb_api_key

STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
STRIPE_PREMIUM_PRICE_ID=your_stripe_subscription_price_id

RESEND_API_KEY=your_resend_api_key
EMAIL_FROM=your_verified_sender_email
```

Additional optional settings:

```env
CORS_ORIGINS=http://localhost:3000
DNS_SERVERS=8.8.8.8,1.1.1.1
```

**Never commit real `.env` files, API keys, or credentials to GitHub.**

### 4. Start Development Server

```bash
npm run dev
```

Server:

http://localhost:5000

Health check:

http://localhost:5000/health

### 5. Start Production Server

```bash
npm start
```

## 🧪 Testing

Run the backend tests:

```bash
npm test
```

The test suite covers authentication, authorization, and application business rules. The MongoDB-backed concurrency test is skipped unless `TEST_MONGODB_URI` is set (test-only; see `.env.example`). Stripe webhook tests use mocked payloads and do not create real payments.

## 💳 Stripe Subscription Flow

1. A vendor selects Upgrade to Premium.
2. The backend creates a Stripe Checkout Session.
3. The vendor completes the subscription payment through Stripe.
4. Stripe sends an event to the backend webhook.
5. The webhook signature is verified before subscription information is updated.
6. Premium access is granted based on verified subscription status.

**Important:** Stripe payments are required for vendor subscriptions only. Customers do not need Stripe to place pizza orders.

## 🚀 Production Deployment

The backend is hosted on **Render**, with MongoDB Atlas as the database.

### Render Configuration

| Setting | Value |
|---|---|
| Runtime | Node.js |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Branch | `main` |

Production environment values must use the actual Render and Vercel URLs.

### Production Authentication

- Configure `BETTER_AUTH_URL` with the deployed backend origin.
- Configure `CLIENT_URL` with the deployed frontend origin.
- Configure Google OAuth redirect URIs.
- Verify production CORS and session-cookie behavior.
- Test both Google and email/password authentication.

### Stripe Webhook

Configure the Stripe webhook destination as:

```text
https://pizza-hub-server.onrender.com/api/billing/webhook
```

Ensure the webhook signing secret is configured securely in Render. Enable only
`checkout.session.completed`, `customer.subscription.updated`,
`customer.subscription.deleted`, and `invoice.payment_failed` on that endpoint.

### Database indexes

The app never creates indexes at boot. Production startup only performs a
read-only verification and fails if a critical index is missing. Before the
first production deployment, follow `DEPLOYMENT.md` to run the read-only checks
and then, during a controlled maintenance window, run:

```bash
npm run indexes:verify
CONFIRM_INDEX_CREATE=yes npm run indexes:create
```

The creation script re-runs duplicate/type checks and aborts before writing
indexes if any conflict exists. It is an explicit operator command, not part of
startup or tests.

## 📌 Important Notes

- Approved, active items appear in public menu lists; single-item details require authentication.
- Only approved and active menu items can be ordered.
- Vendors may manage only their own resources.
- Only pending orders can be accepted or rejected.
- Subscription privileges must not be granted based solely on frontend payment redirects.
- The production login and Stripe payment flows should be verified before final submission.

## 👩‍💻 Author

Developed as a full-stack web development assignment.

### Active-order uniqueness (important migration note)

The required `orders_unique_active_customer_pizza_date` unique partial index
uses `{ status: { $in: ["pending", "accepted", "preparing", "out_for_delivery"] } }` so all in-progress
orders **share the same uniqueness constraint** for each customer, pizza, and
canonical UTC delivery date. Separate per-status indexes do not enforce this.
The server derives `deliveryDateKey` from `deliveryDate`; it never trusts a
client-supplied date key. Before deploying, backfill older active orders,
check duplicates across *all active* statuses, create the combined index and retire
legacy order unique indexes through an operator-approved migration.
Never run production index changes automatically.
