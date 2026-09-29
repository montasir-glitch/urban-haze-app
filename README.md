# Urban Haze: setup, architecture and plan

## 1. Tech stack
| Layer | Choice | Why |
|---|---|---|
| Frontend | HTML/CSS/JS (`public/`) | Your existing storefront plus sign-up, checkout, dashboard, policies |
| Backend | Node.js 20+ and Express 5 (`server.js`) | One file, easy to read and deploy |
| Database | PostgreSQL with Prisma 6 | Parameterised queries, so no SQL injection |
| Auth | Own email/password (Argon2id, JWT in an HttpOnly cookie) plus Google sign-in | Meets your spec. Supabase Auth or Firebase Auth are good managed alternatives |
| Bangladesh payments | SSLCommerz (bKash, Nagad, Rocket, local cards). Shurjopay works the same way | One integration covers all local wallets |
| International | Stripe Checkout, Payoneer or bank transfer with proof upload | See the note in section 6 |

## 2. Architecture
```
Browser (public/) --HTTPS--> Express (server.js) --> PostgreSQL (User, Transaction)
                                |-- SSLCommerz  init -> gateway page -> success/fail/cancel/ipn -> server re-validates
                                |-- Stripe      init -> Checkout -> signed webhook -> COMPLETED
                                '-- Manual      reference + proof upload -> PENDING -> admin approves
```
Prices are stored on the server (`CATALOG` in `server.js`). The browser only sends product IDs and quantities.

## 3. Run it locally
```bash
npm install express helmet cors express-rate-limit cookie-parser argon2 jsonwebtoken zod multer stripe nodemailer google-auth-library dotenv @prisma/client@6
npm install -D prisma@6
cp .env.example .env        # fill in the values (section 4)
npx prisma migrate dev --name init
npm run dev                 # http://localhost:3000
```
Password-reset links print in the console until you add SMTP settings.

## 4. Where the keys go (`.env`)
- `JWT_SECRET`: run `openssl rand -hex 48`.
- `DATABASE_URL`: from Neon, Supabase, Railway or Render Postgres.
- `SSL_STORE_ID` / `SSL_STORE_PASS`: from your SSLCommerz sandbox, then live, account.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: Stripe dashboard.
- `GOOGLE_CLIENT_ID`: Google Cloud Console, OAuth Web client. Add your site URL as an authorised origin, and also paste the same ID into `GOOGLE_CLIENT_ID` at the top of `public/account.js`.
- `SMTP_*`: any email provider (Brevo, Resend SMTP, Gmail app password).
Never commit `.env`. It is already in `.gitignore`.

## 5. Deploy
1. Push the folder to GitHub and create a Node web service on Render, Railway or a VPS.
2. Build command: `npm install && npx prisma generate`. Start command: `npx prisma migrate deploy && npm start`.
3. Set every `.env` value in the host's dashboard. Use `NODE_ENV=production` and `APP_URL=https://your-domain`.
4. HTTPS: Render and Railway give it automatically. On a VPS, put Nginx and Let's Encrypt in front. The server redirects HTTP to HTTPS and sends HSTS.
5. Callbacks:
   - SSLCommerz merchant panel, IPN URL: `https://your-domain/api/pay/sslcommerz/ipn`.
   - Stripe, webhook endpoint: `https://your-domain/api/pay/stripe/webhook`, events `checkout.session.completed` and `checkout.session.expired`.
6. Make yourself admin: `UPDATE "User" SET role='ADMIN' WHERE email='you@example.com';`
   Approve a manual payment: `PATCH /api/admin/transactions/:id` with `{"status":"COMPLETED"}`. View its receipt at `GET /api/admin/proof/:id`.

## 6. Before you take real money
- Test everything in sandbox first (SSLCommerz sandbox, Stripe test cards). Set `SSL_LIVE=true` only with live keys.
- **Stripe** does not accept Bangladesh-registered businesses. It needs a company in a supported country. **PayPal** receiving in Bangladesh is restricted or unavailable, so I left it out. Payoneer, bank transfer and SSLCommerz are the practical routes.
- Add a shipping address form. It is not collected yet.
- The three policies are generic templates. Replace the email addresses and have a lawyer review them.
- Keep prices in `server.js` and `public/index.html` in sync.
- Consider Sentry for errors and daily database backups.

## 7. Security in this build
Argon2id salted hashing, HttpOnly + Secure + SameSite cookies, zod validation on every route, Prisma parameterised queries, `textContent` rendering of user data (XSS), Helmet headers and CSP, CORS locked to `APP_URL`, rate limits (10 auth attempts and 20 payment requests per 15 minutes per IP), server-side amount checks, gateway re-validation, signed Stripe webhooks, and upload limits (5 MB, JPG/PNG/PDF, admin-only access).
