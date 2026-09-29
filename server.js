import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import multer from 'multer';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import { PrismaClient } from '@prisma/client';

const E = process.env, PROD = E.NODE_ENV === 'production';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const stripe = new Stripe(E.STRIPE_SECRET_KEY || 'sk_test_missing');
const gClient = new OAuth2Client(E.GOOGLE_CLIENT_ID);
const mailer = nodemailer.createTransport({ host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } });
const SSL = E.SSL_LIVE === 'true' ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Prices (USD) live on the server so customers can never change what they pay. Keep in sync with public/index.html.
const CATALOG = { 1: 129, 2: 249, 3: 89, 4: 199, 5: 59, 6: 699, 7: 449, 8: 49, 9: 59 };

// ---------- validation (zod) ----------
const email = z.string().trim().toLowerCase().email().max(120);
const password = z.string().min(10, 'Password must be at least 10 characters').max(128);
const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email,
  phone: z.string().trim().regex(/^\+?[0-9]{10,15}$/, 'Enter a valid phone number'),
  password,
  terms: z.literal(true, { errorMap: () => ({ message: 'Please accept the Terms and Privacy Policy' }) }),
});
const cartSchema = z.object({
  items: z.array(z.object({ id: z.number().int().refine(i => i in CATALOG), qty: z.number().int().min(1).max(20) })).min(1).max(30),
});
const usd = items => items.reduce((s, i) => s + CATALOG[i.id] * i.qty, 0);
const mk = (u, method, currency, amount, items, extra = {}) => prisma.transaction.create({
  data: { tranId: 'UH' + Date.now() + crypto.randomInt(1000, 9999), userId: u.id, method, currency, amount, items, ...extra },
});

// ---------- sessions ----------
const setSession = (res, u) => res.cookie('uh_session', jwt.sign({ sub: u.id }, E.JWT_SECRET, { expiresIn: '7d' }),
  { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 7 * 864e5 });
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const auth = async (req, res, next) => {
  try {
    const { sub } = jwt.verify(req.cookies.uh_session, E.JWT_SECRET);
    req.user = await prisma.user.findUnique({ where: { id: sub } });
    if (req.user) return next();
  } catch {}
  res.status(401).json({ error: 'Please sign in' });
};
const admin = (req, res, next) => (req.user.role === 'ADMIN' ? next() : res.sendStatus(403));

// ---------- app + security ----------
const app = express();
app.set('trust proxy', 1);
if (PROD) app.use((req, res, next) => (req.secure ? next() : res.redirect(301, 'https://' + req.headers.host + req.url))); // force HTTPS
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true },
  contentSecurityPolicy: { directives: {
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'], // move inline JS to a file to drop 'unsafe-inline'
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
    fontSrc: ['https://fonts.gstatic.com'],
    imgSrc: ["'self'", 'data:'],
    frameSrc: ['https://accounts.google.com'],
    connectSrc: ["'self'", 'https://accounts.google.com'],
  } },
}));
app.use(cors({ origin: E.APP_URL, credentials: true })); // only your own site may call the API
app.use(cookieParser());

// Stripe webhook needs the RAW body, so it is registered before express.json()
app.post('/api/pay/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let ev;
  try { ev = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], E.STRIPE_WEBHOOK_SECRET); }
  catch { return res.sendStatus(400); }
  const s = ev.data.object;
  if (ev.type === 'checkout.session.completed' && s.payment_status === 'paid')
    await prisma.transaction.updateMany({ where: { tranId: s.client_reference_id, status: 'PENDING' }, data: { status: 'COMPLETED', gatewayRef: s.id } });
  if (ev.type === 'checkout.session.expired')
    await prisma.transaction.updateMany({ where: { tranId: s.client_reference_id, status: 'PENDING' }, data: { status: 'FAILED' } });
  res.json({ received: true });
});

app.use(express.json({ limit: '20kb' }));
const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, message: { error: 'Too many attempts. Try again later.' } });
const payLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: true, message: { error: 'Too many payment requests. Try again later.' } });
app.use('/api/auth', authLimiter);

// ---------- auth ----------
app.post('/api/auth/register', async (req, res) => {
  const d = registerSchema.parse(req.body);
  if (await prisma.user.findUnique({ where: { email: d.email } })) return res.status(409).json({ error: 'Email already registered' });
  const u = await prisma.user.create({ data: { name: d.name, email: d.email, phone: d.phone, passwordHash: await argon2.hash(d.password) } }); // Argon2id, salted
  setSession(res, u); res.status(201).json(pub(u));
});
app.post('/api/auth/login', async (req, res) => {
  const d = z.object({ email, password: z.string().max(128) }).parse(req.body);
  const u = await prisma.user.findUnique({ where: { email: d.email } });
  if (!u?.passwordHash || !(await argon2.verify(u.passwordHash, d.password))) return res.status(401).json({ error: 'Wrong email or password' });
  setSession(res, u); res.json(pub(u));
});
app.post('/api/auth/google', async (req, res) => {
  const t = await gClient.verifyIdToken({ idToken: z.string().parse(req.body.credential), audience: E.GOOGLE_CLIENT_ID });
  const p = t.getPayload();
  if (!p.email_verified) return res.status(401).json({ error: 'Google email is not verified' });
  let u = await prisma.user.findUnique({ where: { email: p.email } });
  u = u ? (u.googleId ? u : await prisma.user.update({ where: { id: u.id }, data: { googleId: p.sub } }))
        : await prisma.user.create({ data: { name: p.name || p.email, email: p.email, googleId: p.sub } });
  setSession(res, u); res.json(pub(u));
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('uh_session'); res.json({ ok: true }); });
app.post('/api/auth/forgot', async (req, res) => {
  const { email: addr } = z.object({ email }).parse(req.body);
  const u = await prisma.user.findUnique({ where: { email: addr } });
  if (u) {
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.user.update({ where: { id: u.id }, data: { resetHash: sha(raw), resetExpires: new Date(Date.now() + 36e5) } });
    const link = `${E.APP_URL}/?reset=${raw}`;
    if (E.SMTP_HOST) await mailer.sendMail({ from: E.MAIL_FROM, to: u.email, subject: 'Reset your Urban Haze password', text: `Reset your password (valid for 1 hour): ${link}` });
    else console.log('DEV reset link:', link);
  }
  res.json({ ok: true }); // same reply whether or not the email exists
});
app.post('/api/auth/reset', async (req, res) => {
  const d = z.object({ token: z.string().length(64), password }).parse(req.body);
  const u = await prisma.user.findFirst({ where: { resetHash: sha(d.token), resetExpires: { gt: new Date() } } });
  if (!u) return res.status(400).json({ error: 'Reset link is invalid or expired' });
  await prisma.user.update({ where: { id: u.id }, data: { passwordHash: await argon2.hash(d.password), resetHash: null, resetExpires: null } });
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));
app.get('/api/transactions', auth, async (req, res) => res.json(await prisma.transaction.findMany({
  where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100,
  select: { tranId: true, amount: true, currency: true, method: true, status: true, createdAt: true },
})));

// ---------- SSLCommerz: bKash, Nagad, Rocket, local cards ----------
app.post('/api/pay/sslcommerz/init', payLimiter, auth, async (req, res) => {
  const { items } = cartSchema.parse(req.body);
  const bdt = (usd(items) * Number(E.USD_TO_BDT || 120)).toFixed(2);
  const tx = await mk(req.user, 'SSLCOMMERZ', 'BDT', bdt, items);
  const cb = n => `${E.APP_URL}/api/pay/sslcommerz/${n}`;
  const r = await fetch(SSL + '/gwprocess/v4/api.php', { method: 'POST', body: new URLSearchParams({
    store_id: E.SSL_STORE_ID, store_passwd: E.SSL_STORE_PASS, total_amount: bdt, currency: 'BDT', tran_id: tx.tranId,
    success_url: cb('success'), fail_url: cb('fail'), cancel_url: cb('cancel'), ipn_url: cb('ipn'),
    cus_name: req.user.name, cus_email: req.user.email, cus_phone: req.user.phone || '01700000000',
    cus_add1: 'N/A', cus_city: 'Dhaka', cus_country: 'Bangladesh',
    shipping_method: 'NO', product_name: 'Urban Haze order', product_category: 'Electronics', product_profile: 'general',
  }) });
  const d = await r.json();
  if (!d.GatewayPageURL) return res.status(502).json({ error: 'Payment gateway unavailable' });
  res.json({ url: d.GatewayPageURL });
});
// Never trust the redirect itself: always confirm with SSLCommerz's validation API and compare amount + currency.
async function verifySSL(valId, tranId) {
  if (!valId || !tranId) return false;
  const q = new URLSearchParams({ val_id: valId, store_id: E.SSL_STORE_ID, store_passwd: E.SSL_STORE_PASS, format: 'json' });
  const d = await (await fetch(`${SSL}/validator/api/validationserverAPI.php?${q}`)).json();
  const tx = await prisma.transaction.findUnique({ where: { tranId } });
  const ok = !!tx && ['VALID', 'VALIDATED'].includes(d.status) && d.tran_id === tranId && Number(d.amount) === Number(tx.amount) && d.currency_type === 'BDT';
  if (tx?.status === 'PENDING') await prisma.transaction.update({ where: { tranId }, data: { status: ok ? 'COMPLETED' : 'FAILED', gatewayRef: d.bank_tran_id || null } });
  return ok;
}
const form = express.urlencoded({ extended: false });
app.post('/api/pay/sslcommerz/success', form, async (req, res) => res.redirect('/?pay=' + (await verifySSL(req.body.val_id, req.body.tran_id) ? 'success' : 'failed')));
app.post('/api/pay/sslcommerz/ipn', form, async (req, res) => { await verifySSL(req.body.val_id, req.body.tran_id); res.sendStatus(200); });
app.post('/api/pay/sslcommerz/fail', form, async (req, res) => {
  await prisma.transaction.updateMany({ where: { tranId: String(req.body.tran_id), status: 'PENDING' }, data: { status: 'FAILED' } }); res.redirect('/?pay=failed');
});
app.post('/api/pay/sslcommerz/cancel', form, async (req, res) => {
  await prisma.transaction.updateMany({ where: { tranId: String(req.body.tran_id), status: 'PENDING' }, data: { status: 'CANCELLED' } }); res.redirect('/?pay=cancelled');
});

// ---------- Stripe: international cards ----------
app.post('/api/pay/stripe/init', payLimiter, auth, async (req, res) => {
  const { items } = cartSchema.parse(req.body);
  const total = usd(items), tx = await mk(req.user, 'STRIPE', 'USD', total, items);
  const s = await stripe.checkout.sessions.create({
    mode: 'payment', customer_email: req.user.email, client_reference_id: tx.tranId,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(total * 100), product_data: { name: 'Urban Haze order' } } }],
    success_url: `${E.APP_URL}/?pay=success`, cancel_url: `${E.APP_URL}/?pay=cancelled`,
  });
  res.json({ url: s.url });
});

// ---------- Manual: bank transfer / Payoneer / bKash-Nagad-Rocket send money (TxID) ----------
const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (r, f, cb) => cb(null, ['image/jpeg', 'image/png', 'application/pdf'].includes(f.mimetype)) });
app.post('/api/pay/manual', payLimiter, auth, upload.single('proof'), async (req, res) => {
  const d = z.object({ method: z.enum(['BANK_PAYONEER', 'MFS_MANUAL']), reference: z.string().trim().min(4).max(64) }).parse(req.body);
  const { items } = cartSchema.parse({ items: JSON.parse(req.body.items || '[]') });
  const tx = await mk(req.user, d.method, 'USD', usd(items), items, { reference: d.reference, proofPath: req.file?.filename });
  res.status(201).json({ tranId: tx.tranId }); // stays PENDING until an admin verifies it
});
app.patch('/api/admin/transactions/:id', auth, admin, async (req, res) => {
  const { status } = z.object({ status: z.enum(['COMPLETED', 'FAILED']) }).parse(req.body);
  res.json(await prisma.transaction.update({ where: { id: req.params.id }, data: { status } }));
});
app.get('/api/admin/proof/:id', auth, admin, async (req, res) => {
  const t = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!t?.proofPath) return res.sendStatus(404);
  res.sendFile(path.join(__dirname, 'uploads', t.proofPath));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Please check your details', details: err.issues.map(i => i.message) });
  console.error(err); res.status(500).json({ error: 'Something went wrong' });
});
app.listen(E.PORT || 3000, () => console.log('Urban Haze running on port', E.PORT || 3000));
