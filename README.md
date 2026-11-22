
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
Customers can browse approved items, place orders, track order statuses, cancel eligible orders, manage wishlists, and submit reviews.

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

Menu management endpoints are available under:

`/api/menu`

These support public browsing, filtering, featured items, and vendor menu management.

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

The menu API supports filtering by item name, category, and location, along with ascending and descending price sorting.

This allows the frontend to request relevant approved and active menu items.

### JWT Verification

Better Auth manages authentication and provides JWT functionality. JWT verification middleware validates signed tokens through the configured signing keys and rejects invalid or expired tokens.

Backend authorization separately checks user roles, blocked status, and resource ownership.

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

The test suite covers authentication, authorization, and application business rules.

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
| Build Command | `npm ci` |
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

Ensure the webhook signing secret is configured securely in Render.

## 📌 Important Notes

- Menu items must be approved before appearing publicly.
- Only approved and active menu items can be ordered.
- Vendors may manage only their own resources.
- Only pending orders can be accepted or rejected.
- Subscription privileges must not be granted based solely on frontend payment redirects.
- The production login and Stripe payment flows should be verified before final submission.

## 👩‍💻 Author

Developed as a full-stack web development assignment.
