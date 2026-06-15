import express from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Init Firebase Admin
initializeApp({
  credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = getFirestore();
const auth = getAuth();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 8080;
const verificationCodes = new Map();
const supportRateLimits = new Map();
const supportChatRateLimits = new Map();
const WEBSITE_ORIGINS = new Set([
  'https://leaguepicker.com',
  'https://www.leaguepicker.com',
  'https://league-picker-website.mathater25.workers.dev',
]);

const MONTHLY_PRICE_ID = 'price_1TgzXHCz5sLysbuTT5VziDxV';
const YEARLY_PRICE_ID  = 'price_1TgzYDCz5sLysbuT5jFxBPoF';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && WEBSITE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

async function getVerificationUser(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    const error = new Error('You must be signed in');
    error.status = 401;
    throw error;
  }

  const decoded = await auth.verifyIdToken(idToken);
  const [authUser, profileSnapshot] = await Promise.all([
    auth.getUser(decoded.uid),
    db.collection('users').doc(decoded.uid).get(),
  ]);
  const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
  if (!profileSnapshot.exists) {
    await db.collection('users').doc(decoded.uid).set({
      email: authUser.email || '',
      username: authUser.displayName
        ? authUser.displayName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)
        : '',
      tier: 'free',
      is_admin: false,
      is_banned: false,
      email_verified: authUser.emailVerified === true,
      theme: 'dark-gold',
      sound_enabled: true,
      auto_accept: false,
    }, { merge: true });
    profile.email = authUser.email || '';
    profile.username = authUser.displayName
      ? authUser.displayName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)
      : '';
    profile.tier = 'free';
    profile.email_verified = authUser.emailVerified === true;
  }
  const isAdmin = profile?.is_admin === true;

  // Existing accounts have no marker and remain verified. New password accounts
  // are created with email_verified=false until they enter the emailed code.
  const needsVerification =
    !isAdmin &&
    authUser.emailVerified !== true &&
    profile?.email_verified === false;

  return {
    uid: decoded.uid,
    email: authUser.email,
    isAdmin,
    needsVerification,
  };
}

async function getWebsiteUser(req, requireAdmin = false) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    const error = new Error('You must be signed in');
    error.status = 401;
    throw error;
  }

  const decoded = await auth.verifyIdToken(idToken);
  const [authUser, profileSnapshot] = await Promise.all([
    auth.getUser(decoded.uid),
    db.collection('users').doc(decoded.uid).get(),
  ]);
  const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
  if (!profileSnapshot.exists) {
    const username = authUser.displayName
      ? authUser.displayName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 20)
      : '';
    Object.assign(profile, {
      email: authUser.email || '',
      username,
      tier: 'free',
      is_admin: false,
      is_banned: false,
      email_verified: authUser.emailVerified === true,
      theme: 'dark-gold',
      sound_enabled: true,
      auto_accept: false,
    });
    await db.collection('users').doc(decoded.uid).set(profile, { merge: true });
  }
  if (profile?.is_banned === true || authUser.disabled) {
    const error = new Error('This account is disabled');
    error.status = 403;
    throw error;
  }
  if (requireAdmin && profile?.is_admin !== true) {
    const error = new Error('Administrator access is required');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid, authUser, profile, isAdmin: profile?.is_admin === true };
}

function publicDevice(doc) {
  const data = doc.data() || {};
  return {
    deviceId: doc.id,
    deviceName: data.device_name || 'Unknown Windows device',
    adminLabel: data.admin_label || '',
    appVersion: data.app_version || '',
    created: data.created || '',
    lastSeen: data.last_seen || '',
    banned: data.banned === true,
    reason: data.reason || '',
    uid: data.uid || '',
    username: data.username || '',
    email: data.email || '',
  };
}

function publicUser(doc) {
  const data = doc.data() || {};
  return {
    uid: doc.id,
    email: data.email || '',
    username: data.username || '',
    tier: data.tier || 'free',
    isAdmin: data.is_admin === true,
    isBanned: data.is_banned === true,
    emailVerified: data.email_verified !== false,
  };
}

function hashVerificationCode(uid, code) {
  const secret = process.env.EMAIL_VERIFICATION_SECRET;
  if (!secret) {
    throw new Error('EMAIL_VERIFICATION_SECRET is not configured');
  }
  return crypto.createHmac('sha256', secret).update(`${uid}:${code}`).digest();
}

async function sendVerificationEmail(email, code) {
  const brevoApiKey = process.env.BREVO_API_KEY;
  const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const subject = 'Your League Picker verification code';
  const text = `Your League Picker verification code is ${code}. It expires in 10 minutes.`;
  const html = `
        <!doctype html>
        <html lang="en">
          <body style="margin:0;padding:0;background:#030a13;font-family:Segoe UI,Arial,sans-serif;color:#f0e6c0">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#030a13">
              <tr>
                <td align="center" style="padding:36px 16px">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#0d1928;border:1px solid #26384d;border-radius:8px">
                    <tr>
                      <td align="center" style="padding:34px 34px 14px">
                        <div style="display:inline-block;padding:10px 13px;border-radius:8px;background:#c89b3c;color:#07111f;font-size:22px;font-weight:800;line-height:1">LP</div>
                        <div style="margin-top:14px;color:#c89b3c;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">League Picker</div>
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="padding:8px 34px 0">
                        <h1 style="margin:0;color:#f0e6c0;font-size:24px;line-height:1.3;font-weight:700">Verify your email</h1>
                        <p style="margin:12px 0 0;color:#9fb0c5;font-size:14px;line-height:1.6">Enter this code in the League Picker app to finish creating your account.</p>
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="padding:26px 34px">
                        <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                          <tr>
                            <td style="padding:18px 24px;background:#07111f;border:1px solid #c89b3c;border-radius:8px;color:#f0e6c0;font-family:Consolas,Menlo,monospace;font-size:32px;font-weight:700;letter-spacing:8px">${code}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="padding:0 34px 34px">
                        <p style="margin:0;color:#0bc4ff;font-size:12px;font-weight:600">This code expires in 10 minutes.</p>
                        <p style="margin:14px 0 0;color:#6f8196;font-size:11px;line-height:1.6">If you did not create a League Picker account, you can safely ignore this email.</p>
                      </td>
                    </tr>
                  </table>
                  <p style="margin:16px 0 0;color:#52657a;font-size:10px">League Picker account security</p>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `;

  if (brevoApiKey && brevoSenderEmail) {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'League Picker', email: brevoSenderEmail },
        to: [{ email }],
        subject,
        textContent: text,
        htmlContent: html,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const details = await response.text();
      console.error('Brevo email error:', response.status, details);
      throw new Error(`Email provider rejected the request (HTTP ${response.status})`);
    }
    return;
  }

  if (!smtpUser || !smtpPass) {
    throw new Error('BREVO_API_KEY or Gmail SMTP credentials must be configured');
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from: `"League Picker" <${smtpUser}>`,
    to: email,
    subject,
    text,
    html,
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendSupportEmail({ email, subject, message }) {
  const brevoApiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER;
  const supportEmail = process.env.SUPPORT_EMAIL || 'mathater25@gmail.com';
  if (!brevoApiKey || !senderEmail) {
    throw new Error('Brevo support email is not configured');
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': brevoApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'League Picker Support', email: senderEmail },
      replyTo: { email },
      to: [{ email: supportEmail }],
      subject: `[League Picker Support] ${subject}`,
      textContent: `From: ${email}\n\n${message}`,
      htmlContent: `
        <div style="font-family:Segoe UI,Arial,sans-serif;background:#071624;color:#f5f8fb;padding:28px">
          <div style="max-width:620px;margin:auto;background:#0d2a40;border:1px solid #31506a;border-radius:8px;padding:26px">
            <div style="color:#f4b753;font-size:12px;font-weight:700;text-transform:uppercase">League Picker Support</div>
            <h1 style="font-size:22px;margin:10px 0 20px">${escapeHtml(subject)}</h1>
            <p style="color:#92a9ba;font-size:13px">From: ${escapeHtml(email)}</p>
            <div style="white-space:pre-wrap;line-height:1.7;color:#e6eef3">${escapeHtml(message)}</div>
          </div>
        </div>
      `,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error('Brevo support email error:', response.status, details);
    throw new Error(`Email provider rejected the request (HTTP ${response.status})`);
  }
}

const SUPPORT_KNOWLEDGE = [
  {
    terms: ['download', 'install', 'installer'],
    answer: 'You can download the latest Windows installer directly from leaguepicker.com/download. League Picker currently supports 64-bit Windows 10 and Windows 11.',
  },
  {
    terms: ['update', 'version', 'upgrade'],
    answer: 'League Picker checks for signed updates from the app. You can use Check for Update, or download the latest installer from leaguepicker.com/download without uninstalling first.',
  },
  {
    terms: ['guest', 'without account', 'no account', 'login'],
    answer: 'Guest mode includes the basic tools without signing in. An account is required for Premium, synced settings, linked devices, and website account management.',
  },
  {
    terms: ['premium', 'price', 'cost', 'subscription'],
    answer: 'Premium is $2.99 monthly or $23.99 yearly. It unlocks advanced automation, unlimited role plans, match-history insights, and Premium tools across signed-in devices.',
  },
  {
    terms: ['payment', 'card', 'billing', 'refund', 'cancel'],
    answer: 'Payments are securely handled by Stripe. League Picker never stores full card details. Signed-in customers can manage cards, invoices, and cancellation from the Premium page.',
  },
  {
    terms: ['pick', 'ban', 'champion select', 'draft'],
    answer: 'League Picker can save primary and backup picks and bans for champion select. Role-based plans let you keep different choices for Top, Jungle, Mid, Bottom, and Support.',
  },
  {
    terms: ['smart ban', 'history', 'match analysis'],
    answer: 'Smart-ban analysis uses supported match-history information and saved preferences to suggest useful bans. More match history usually produces stronger recommendations.',
  },
  {
    terms: ['riot', 'profile', 'rank', 'summoner'],
    answer: 'League Picker can connect to the local League client and display supported Riot profile, ranked, and match information. Never share your Riot password or verification code in support chat.',
  },
  {
    terms: ['device', 'ban', 'computer', 'pc'],
    answer: 'Signed-in devices appear in your website account with their Windows device name, app version, and last-seen time. Device restrictions are managed by League Picker administrators.',
  },
  {
    terms: ['email', 'verify', 'verification code', 'google'],
    answer: 'Email accounts use a six-digit verification code. Google sign-in uses your Google account through Firebase. Never send a verification code, password, or recovery code in this chat.',
  },
];

function supportAssistantReply(message) {
  const text = message.toLowerCase();
  const sensitive = ['password', 'verification code', 'otp', 'api key', 'secret key', 'full card', 'cvv', 'social security', 'real name'];
  if (sensitive.some((term) => text.includes(term))) {
    return 'For your safety, do not share passwords, verification codes, API keys, full card numbers, CVV codes, or other private identity information. I can help with general League Picker questions only.';
  }
  const match = SUPPORT_KNOWLEDGE
    .map((entry) => ({ ...entry, score: entry.terms.filter((term) => text.includes(term)).length }))
    .sort((a, b) => b.score - a.score)[0];
  if (match?.score > 0) return match.answer;
  return 'I only answer questions from the League Picker help guide, and I am not confident about that one. Type "talk to a human" and leave your email and message for League Picker support.';
}

function wantsHumanSupport(message) {
  return /(human|real person|talk to (you|someone|support)|contact support|owner|admin)/i.test(message);
}

function publicSupportChat(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    email: data.email || '',
    status: data.status || 'open',
    humanRequested: data.human_requested === true,
    updatedAt: data.updated_at || 0,
    messages: Array.isArray(data.messages) ? data.messages.slice(-100) : [],
  };
}

// Riot verification
const RIOT_CODE = '38b07e36-978c-495f-a36b-e16e6a656b29';
app.get('/riot.txt', (req, res) => {
  res.type('text/plain');
  res.send(RIOT_CODE);
});

// ── Stripe Checkout — create session ────────────────────────────────────────
app.post('/create-checkout', express.json(), async (req, res) => {
  const { priceId, uid, email } = req.body;
  if (!priceId || !uid || !email) return res.status(400).json({ error: 'Missing fields' });
  if (![MONTHLY_PRICE_ID, YEARLY_PRICE_ID].includes(priceId)) {
    return res.status(400).json({ error: 'Invalid price' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      metadata: { uid },
      success_url: 'https://league-picker-backend.onrender.com/success',
      cancel_url:  'https://league-picker-backend.onrender.com/cancel',
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Checkout error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe Webhook — handle payment events ──────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const uid = obj.metadata?.uid;
      if (uid) {
        await db.collection('users').doc(uid).set(
          { tier: 'premium', stripe_customer_id: obj.customer, stripe_subscription_id: obj.subscription },
          { merge: true }
        );
        console.log(`Upgraded ${uid} to premium`);
      }
      break;
    }
    case 'invoice.payment_succeeded': {
      const customers = await db.collection('users').where('stripe_customer_id', '==', obj.customer).get();
      customers.forEach(doc => doc.ref.set({ tier: 'premium' }, { merge: true }));
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const customers = await db.collection('users').where('stripe_customer_id', '==', obj.customer).get();
      customers.forEach(doc => doc.ref.set({ tier: 'free' }, { merge: true }));
      console.log(`Downgraded customer ${obj.customer} to free`);
      break;
    }
  }
  res.json({ received: true });
});

app.post('/website/create-checkout', express.json(), async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const decoded = await auth.verifyIdToken(idToken);
    const [authUser, profileSnapshot] = await Promise.all([
      auth.getUser(decoded.uid),
      db.collection('users').doc(decoded.uid).get(),
    ]);
    const profile = profileSnapshot.exists ? profileSnapshot.data() : {};
    const priceId = req.body?.priceId;

    if (![MONTHLY_PRICE_ID, YEARLY_PRICE_ID].includes(priceId)) {
      return res.status(400).json({ error: 'Invalid price' });
    }
    if (!authUser.email) {
      return res.status(400).json({ error: 'Your account has no email address' });
    }
    if (profile?.is_banned === true) {
      return res.status(403).json({ error: 'This account is disabled' });
    }
    if (
      profile?.is_admin !== true &&
      authUser.emailVerified !== true &&
      profile?.email_verified === false
    ) {
      return res.status(403).json({ error: 'Verify your email before purchasing Premium' });
    }

    const checkoutOptions = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { uid: decoded.uid },
      success_url: 'https://leaguepicker.com/?checkout=success',
      cancel_url: 'https://leaguepicker.com/?checkout=cancelled',
    };
    if (profile?.stripe_customer_id) checkoutOptions.customer = profile.stripe_customer_id;
    else checkoutOptions.customer_email = authUser.email;

    const session = await stripe.checkout.sessions.create(checkoutOptions);
    res.json({ url: session.url });
  } catch (error) {
    console.error('Website checkout error:', error.message);
    res.status(401).json({ error: 'Sign in again before starting checkout' });
  }
});

app.post('/website/billing-portal', express.json(), async (req, res) => {
  try {
    const user = await getWebsiteUser(req);
    const customerId = user.profile?.stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({ error: 'Purchase Premium before managing payment methods' });
    }
    const configurations = await stripe.billingPortal.configurations.list({ active: true, limit: 1 });
    const configuration = configurations.data[0] || await stripe.billingPortal.configurations.create({
      business_profile: {
        headline: 'Manage your League Picker Premium subscription',
        privacy_policy_url: 'https://leaguepicker.com/privacy.html',
        terms_of_service_url: 'https://leaguepicker.com/terms.html',
      },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
      },
    });
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configuration.id,
      return_url: 'https://leaguepicker.com/',
    });
    res.json({ url: portal.url });
  } catch (error) {
    console.error('Website billing portal error:', error.message);
    res.status(error.status || 500).json({ error: error.message || 'Could not open billing settings' });
  }
});

app.get('/website/account', async (req, res) => {
  try {
    const user = await getWebsiteUser(req);
    const devicesPromise = db.collection('devices').where('uid', '==', user.uid).get();
    let billing = { hasCustomer: false, paymentMethods: [], subscription: null };
    if (user.profile?.stripe_customer_id) {
      try {
        const [paymentMethods, subscription] = await Promise.all([
          stripe.paymentMethods.list({
            customer: user.profile.stripe_customer_id,
            type: 'card',
            limit: 5,
          }),
          user.profile?.stripe_subscription_id
            ? stripe.subscriptions.retrieve(user.profile.stripe_subscription_id).catch(() => null)
            : Promise.resolve(null),
        ]);
        billing = {
          hasCustomer: true,
          paymentMethods: paymentMethods.data.map((method) => ({
            id: method.id,
            brand: method.card?.brand || 'card',
            last4: method.card?.last4 || '',
            expMonth: method.card?.exp_month || 0,
            expYear: method.card?.exp_year || 0,
          })),
          subscription: subscription ? {
            status: subscription.status,
            cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
            currentPeriodEnd: subscription.items?.data?.[0]?.current_period_end || null,
          } : null,
        };
      } catch (error) {
        console.error('Could not load website billing details:', error.message);
      }
    }
    const devicesSnapshot = await devicesPromise;
    res.json({
      account: {
        uid: user.uid,
        email: user.authUser.email || user.profile?.email || '',
        username: user.profile?.username || '',
        tier: user.isAdmin ? 'admin' : (user.profile?.tier || 'free'),
        isAdmin: user.isAdmin,
        emailVerified: user.isAdmin || user.authUser.emailVerified === true || user.profile?.email_verified !== false,
        createdAt: user.authUser.metadata?.creationTime || '',
        lastSignIn: user.authUser.metadata?.lastSignInTime || '',
        settings: {
          theme: user.profile?.theme || 'dark-gold',
          soundEnabled: user.profile?.sound_enabled !== false,
          autoAccept: user.profile?.auto_accept === true,
          pickChampion: user.profile?.pick_champ || '',
          banChampion: user.profile?.ban_champ || '',
          profilesConfigured: Boolean(user.profile?.profiles_json),
        },
      },
      devices: devicesSnapshot.docs.map(publicDevice),
      billing,
    });
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Could not load account' });
  }
});

app.patch('/website/account', express.json(), async (req, res) => {
  try {
    const user = await getWebsiteUser(req);
    const username = String(req.body?.username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3-20 characters using letters, numbers, or underscores',
      });
    }
    await db.collection('users').doc(user.uid).set({ username }, { merge: true });
    const devices = await db.collection('devices').where('uid', '==', user.uid).get();
    await Promise.all(devices.docs.map((doc) => doc.ref.set({ username }, { merge: true })));
    res.json({ success: true, username });
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Could not update account' });
  }
});

app.post('/website/account/revoke-sessions', express.json(), async (req, res) => {
  try {
    const user = await getWebsiteUser(req);
    await auth.revokeRefreshTokens(user.uid);
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Could not revoke sessions' });
  }
});

app.get('/website/admin/dashboard', async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    const [users, devices, appConfig, announcement, supportConfig, supportChats] = await Promise.all([
      db.collection('users').get(),
      db.collection('devices').get(),
      db.collection('config').doc('app').get(),
      db.collection('config').doc('announcement').get(),
      db.collection('config').doc('support').get(),
      db.collection('support_chats').orderBy('updated_at', 'desc').limit(100).get(),
    ]);
    res.json({
      users: users.docs.map(publicUser),
      devices: devices.docs.map(publicDevice),
      supportChats: supportChats.docs
        .map(publicSupportChat)
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt)),
      config: {
        minVersion: appConfig.data()?.min_version || '0.0.0',
        announcement: announcement.data()?.message || '',
        supportOnline: supportConfig.data()?.online === true,
      },
    });
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Could not load admin dashboard' });
  }
});

app.patch('/website/admin/users/:uid', express.json(), async (req, res) => {
  try {
    const admin = await getWebsiteUser(req, true);
    const uid = String(req.params.uid || '');
    if (!uid || uid === admin.uid) {
      return res.status(400).json({ error: 'You cannot modify your own administrator account here' });
    }
    const update = {};
    if (req.body?.tier !== undefined) {
      if (!['free', 'premium'].includes(req.body.tier)) {
        return res.status(400).json({ error: 'Invalid account tier' });
      }
      update.tier = req.body.tier;
    }
    if (req.body?.banned !== undefined) update.is_banned = req.body.banned === true;
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No supported changes supplied' });
    await db.collection('users').doc(uid).set(update, { merge: true });
    if ('is_banned' in update) {
      await auth.updateUser(uid, { disabled: update.is_banned });
      if (update.is_banned) await auth.revokeRefreshTokens(uid);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update user' });
  }
});

app.patch('/website/admin/devices/:deviceId', express.json(), async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    const deviceId = String(req.params.deviceId || '');
    const update = {};
    if (req.body?.label !== undefined) update.admin_label = String(req.body.label).trim().slice(0, 80);
    if (req.body?.banned !== undefined) {
      update.banned = req.body.banned === true;
      update.reason = String(req.body.reason || '').trim().slice(0, 240);
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: 'No supported changes supplied' });
    await db.collection('devices').doc(deviceId).set(update, { merge: true });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update device' });
  }
});

app.patch('/website/admin/config', express.json(), async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    const tasks = [];
    if (req.body?.announcement !== undefined) {
      tasks.push(
        db.collection('config').doc('announcement').set(
          { message: String(req.body.announcement).trim().slice(0, 1000) },
          { merge: true },
        ),
      );
    }
    if (req.body?.minVersion !== undefined) {
      const minVersion = String(req.body.minVersion).trim();
      if (!/^\d+\.\d+\.\d+$/.test(minVersion)) {
        return res.status(400).json({ error: 'Minimum version must look like 1.0.48' });
      }
      tasks.push(db.collection('config').doc('app').set({ min_version: minVersion }, { merge: true }));
    }
    if (req.body?.riotKey !== undefined) {
      const riotKey = String(req.body.riotKey).trim();
      if (!riotKey.startsWith('RGAPI-')) {
        return res.status(400).json({ error: 'Riot API key must start with RGAPI-' });
      }
      tasks.push(
        db.collection('config').doc('riot_key').set(
          { key: riotKey, updated_at: Date.now().toString() },
          { merge: true },
        ),
      );
    }
    if (req.body?.supportOnline !== undefined) {
      tasks.push(
        db.collection('config').doc('support').set(
          { online: req.body.supportOnline === true, updated_at: Date.now() },
          { merge: true },
        ),
      );
    }
    if (!tasks.length) return res.status(400).json({ error: 'No supported changes supplied' });
    await Promise.all(tasks);
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update configuration' });
  }
});

app.get('/website/admin/support', async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    res.setHeader('Cache-Control', 'no-store');
    const [supportConfig, supportChats] = await Promise.all([
      db.collection('config').doc('support').get(),
      db.collection('support_chats').orderBy('updated_at', 'desc').limit(100).get(),
    ]);
    res.json({
      online: supportConfig.data()?.online === true,
      chats: supportChats.docs.map(publicSupportChat),
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load support inbox' });
  }
});

app.post('/website/admin/support/:chatId/reply', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    const chatId = String(req.params.chatId || '');
    const text = String(req.body?.message || '').trim().slice(0, 2000);
    if (!chatId || text.length < 1) return res.status(400).json({ error: 'Enter a reply' });
    const ref = db.collection('support_chats').doc(chatId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Conversation not found' });
    const data = snapshot.data() || {};
    const messages = Array.isArray(data.messages) ? data.messages.slice(-99) : [];
    messages.push({ sender: 'admin', text, at: Date.now() });
    await ref.set({ messages, status: 'open', updated_at: Date.now() }, { merge: true });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not send reply' });
  }
});

app.patch('/website/admin/support/:chatId', express.json(), async (req, res) => {
  try {
    await getWebsiteUser(req, true);
    const status = req.body?.status;
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid conversation status' });
    await db.collection('support_chats').doc(String(req.params.chatId || '')).set(
      { status, updated_at: Date.now() },
      { merge: true },
    );
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update conversation' });
  }
});

app.get('/support/chat/status', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const supportConfig = await db.collection('config').doc('support').get();
    res.json({ online: supportConfig.data()?.online === true });
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ online: false });
  }
});

app.get('/support/chat/:chatId', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const chatId = String(req.params.chatId || '');
    if (!/^[a-f0-9-]{36}$/i.test(chatId)) return res.status(400).json({ error: 'Invalid conversation' });
    const [chat, supportConfig] = await Promise.all([
      db.collection('support_chats').doc(chatId).get(),
      db.collection('config').doc('support').get(),
    ]);
    if (!chat.exists) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ chat: publicSupportChat(chat), online: supportConfig.data()?.online === true });
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'Could not load the conversation' });
  }
});

app.post('/support/chat/message', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
    const lastMessage = supportChatRateLimits.get(ip) || 0;
    if (Date.now() - lastMessage < 1_500) {
      return res.status(429).json({ error: 'Please wait a moment before sending another message' });
    }
    const text = String(req.body?.message || '').trim().slice(0, 2000);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 240);
    let chatId = String(req.body?.chatId || '');
    if (!text) return res.status(400).json({ error: 'Enter a message' });
    if (chatId && !/^[a-f0-9-]{36}$/i.test(chatId)) return res.status(400).json({ error: 'Invalid conversation' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (!chatId) chatId = crypto.randomUUID();

    const ref = db.collection('support_chats').doc(chatId);
    const [snapshot, supportConfig] = await Promise.all([
      ref.get(),
      db.collection('config').doc('support').get(),
    ]);
    const data = snapshot.exists ? snapshot.data() || {} : {};
    const messages = Array.isArray(data.messages) ? data.messages.slice(-97) : [];
    const online = supportConfig.data()?.online === true;
    const humanRequested = wantsHumanSupport(text) || data.human_requested === true;
    messages.push({ sender: 'user', text, at: Date.now() });

    if (!online) {
      if (humanRequested) {
        messages.push({
          sender: 'bot',
          text: email
            ? 'League Picker support is offline, but your message and email have been saved. You will receive a reply by email.'
            : 'League Picker support is offline. Enter your email below and send one more message so a human can reply.',
          at: Date.now(),
        });
      } else {
        messages.push({ sender: 'bot', text: supportAssistantReply(text), at: Date.now() });
      }
    }

    const savedEmail = email || data.email || '';
    const shouldNotifyByEmail = !online && humanRequested && Boolean(email) && data.email_notified !== true;
    await ref.set({
      email: savedEmail,
      messages,
      status: data.status || 'open',
      human_requested: humanRequested,
      email_notified: data.email_notified === true || shouldNotifyByEmail,
      created_at: data.created_at || Date.now(),
      updated_at: Date.now(),
    }, { merge: true });
    supportChatRateLimits.set(ip, Date.now());

    if (shouldNotifyByEmail) {
      await sendSupportEmail({
        email,
        subject: 'Offline chat message',
        message: `Conversation: ${chatId}\n\n${text}`,
      }).catch((error) => console.error('Offline chat email error:', error.message));
    }

    const saved = await ref.get();
    res.json({ chat: publicSupportChat(saved), online });
  } catch (error) {
    console.error('Support chat error:', error.message);
    res.status(500).json({ error: 'Could not send the chat message' });
  }
});

app.post('/support', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();
    const website = String(req.body?.website || '').trim();
    const ip = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
    const lastSent = supportRateLimits.get(ip) || 0;

    if (website) return res.json({ success: true });
    if (Date.now() - lastSent < 60_000) {
      return res.status(429).json({ error: 'Please wait a minute before sending another message' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (subject.length < 3 || subject.length > 100) {
      return res.status(400).json({ error: 'Subject must be between 3 and 100 characters' });
    }
    if (message.length < 10 || message.length > 4000) {
      return res.status(400).json({ error: 'Message must be between 10 and 4000 characters' });
    }

    await sendSupportEmail({ email, subject, message });
    supportRateLimits.set(ip, Date.now());
    res.json({ success: true });
  } catch (error) {
    console.error('Support request error:', error.message);
    res.status(500).json({ error: 'Could not send your message. Please try again.' });
  }
});

// ── Email ownership verification ─────────────────────────────────────────────
app.post('/email-verification/status', express.json(), async (req, res) => {
  try {
    const user = await getVerificationUser(req.body?.idToken);
    res.json({
      success: true,
      verified: !user.needsVerification,
      needsVerification: user.needsVerification,
      email: user.email || '',
      isAdmin: user.isAdmin,
    });
  } catch (error) {
    console.error('Email verification status error:', error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 401 ? error.message : 'Could not check email verification',
    });
  }
});

app.post('/email-verification/request', express.json(), async (req, res) => {
  try {
    const user = await getVerificationUser(req.body?.idToken);
    if (!user.needsVerification) {
      return res.json({ success: true, verified: true, email: user.email || '' });
    }
    if (!user.email) {
      return res.status(400).json({ success: false, message: 'This account has no email address' });
    }

    const now = Date.now();
    const existing = verificationCodes.get(user.uid);
    if (existing && now - existing.sentAt < 60_000) {
      return res.status(429).json({
        success: false,
        message: 'Please wait one minute before requesting another code',
      });
    }

    const code = crypto.randomInt(100000, 1000000).toString();
    await sendVerificationEmail(user.email, code);
    verificationCodes.set(user.uid, {
      hash: hashVerificationCode(user.uid, code),
      expiresAt: now + 10 * 60_000,
      sentAt: now,
      attempts: 0,
    });

    res.json({
      success: true,
      verified: false,
      email: user.email,
      message: 'Verification code sent',
    });
  } catch (error) {
    console.error('Email verification request error:', error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 401 ? error.message : 'Could not send the verification code',
    });
  }
});

app.post('/email-verification/confirm', express.json(), async (req, res) => {
  try {
    const user = await getVerificationUser(req.body?.idToken);
    if (!user.needsVerification) {
      return res.json({ success: true, verified: true });
    }

    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, message: 'Enter the six-digit code' });
    }

    const pending = verificationCodes.get(user.uid);
    if (!pending || pending.expiresAt < Date.now()) {
      verificationCodes.delete(user.uid);
      return res.status(400).json({
        success: false,
        message: 'That code expired. Request a new one.',
      });
    }
    if (pending.attempts >= 5) {
      verificationCodes.delete(user.uid);
      return res.status(429).json({
        success: false,
        message: 'Too many attempts. Request a new code.',
      });
    }

    pending.attempts += 1;
    const submittedHash = hashVerificationCode(user.uid, code);
    if (
      submittedHash.length !== pending.hash.length ||
      !crypto.timingSafeEqual(submittedHash, pending.hash)
    ) {
      return res.status(400).json({ success: false, message: 'The verification code is incorrect' });
    }

    await Promise.all([
      auth.updateUser(user.uid, { emailVerified: true }),
      db.collection('users').doc(user.uid).set({ email_verified: true }, { merge: true }),
    ]);
    verificationCodes.delete(user.uid);

    res.json({ success: true, verified: true, message: 'Email verified' });
  } catch (error) {
    console.error('Email verification confirm error:', error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.status === 401 ? error.message : 'Could not verify the email code',
    });
  }
});

// ── Success / Cancel pages ───────────────────────────────────────────────────
app.get('/success', (req, res) => {
  res.type('text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Payment Successful</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#010A13;color:#F0E6C0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
  h1{color:#C89B3C;font-size:28px}p{color:#A09070;font-size:14px}span{font-size:48px}</style></head>
  <body><span>🎉</span><h1>Payment Successful!</h1><p>Your League Picker account has been upgraded to Premium.</p><p>You can close this tab and return to the app.</p></body></html>`);
});

app.get('/cancel', (req, res) => {
  res.type('text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Payment Cancelled</title>
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#010A13;color:#F0E6C0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
  h1{color:#C89B3C;font-size:28px}p{color:#A09070;font-size:14px}span{font-size:48px}</style></head>
  <body><span>❌</span><h1>Payment Cancelled</h1><p>No charge was made. You can close this tab and return to the app.</p></body></html>`);
});

// ── Landing page ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.type('text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>League Picker</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#010A13;color:#F0E6C0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px}
    .logo{font-size:48px;margin-bottom:16px}
    h1{font-size:32px;font-weight:700;color:#C89B3C;margin-bottom:8px}
    .tagline{font-size:16px;color:#A09070;margin-bottom:40px;text-align:center}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;max-width:860px;width:100%}
    .card{background:rgba(255,255,255,0.05);border:1px solid rgba(200,155,60,0.2);border-radius:10px;padding:20px}
    .card-icon{font-size:28px;margin-bottom:10px}
    .card h3{font-size:14px;font-weight:700;color:#C89B3C;margin-bottom:6px}
    .card p{font-size:12px;color:#A09070;line-height:1.5}
    .api-section{margin-top:40px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:24px;max-width:860px;width:100%}
    .api-section h2{font-size:16px;font-weight:700;color:#C89B3C;margin-bottom:12px}
    .endpoint{font-family:monospace;font-size:12px;color:#0BC4FF;background:rgba(11,196,255,0.08);padding:6px 10px;border-radius:4px;margin-bottom:6px}
    .badge{display:inline-block;background:rgba(200,155,60,0.15);border:1px solid rgba(200,155,60,0.3);color:#C89B3C;font-size:11px;padding:2px 8px;border-radius:12px;margin-top:20px}
    footer{margin-top:40px;font-size:11px;color:#5C5043}
  </style>
</head>
<body>
  <div class="logo">⚔</div>
  <h1>League Picker</h1>
  <p class="tagline">A Windows desktop companion app for League of Legends champion select</p>
  <div class="cards">
    <div class="card"><div class="card-icon">🎯</div><h3>Champion Select Helper</h3><p>Players pre-configure their preferred pick and ban choices. The app automatically locks in their pre-selected champion when their turn arrives in champion select.</p></div>
    <div class="card"><div class="card-icon">📊</div><h3>Personal Match Analytics</h3><p>Uses the Riot API to pull the player's own match history and calculate win rates against specific champions, generating personalized ban suggestions based on their actual performance data.</p></div>
    <div class="card"><div class="card-icon">💾</div><h3>Pick/Ban Profiles</h3><p>Save multiple champion select configurations for different roles or game modes and switch between them instantly.</p></div>
    <div class="card"><div class="card-icon">🔒</div><h3>Privacy First</h3><p>All personal data is stored in the user's own Firebase account. The app only reads LCU data for the current user's client — no data is collected or shared.</p></div>
    <div class="card"><div class="card-icon">⚙️</div><h3>Built with Tauri</h3><p>Native Windows desktop app built with Rust + React. Uses the official League Client Update (LCU) API to interact with the game client safely and within Riot's guidelines.</p></div>
    <div class="card"><div class="card-icon">📋</div><h3>Riot API Usage</h3><p>Uses MATCH-V5 to retrieve match history, SUMMONER-V4 for account lookup. All requests are rate-limited and cached. No real-time in-game data is read.</p></div>
  </div>
  <div class="api-section">
    <h2>API Endpoints Used</h2>
    <div class="endpoint">GET /lol/match/v5/matches/by-puuid/{puuid}/ids</div>
    <div class="endpoint">GET /lol/match/v5/matches/{matchId}</div>
    <div class="endpoint">GET /lol/summoner/v4/summoners/by-name/{summonerName}</div>
    <div class="endpoint">GET /lol/league/v4/entries/by-summoner/{encryptedSummonerId}</div>
    <p style="font-size:12px;color:#5C5043;margin-top:12px">Match data is fetched once on app startup and cached locally. No polling or real-time requests are made during gameplay.</p>
  </div>
  <span class="badge">Riot API Applicant — Personal Use + Public Release</span>
  <footer>League Picker is not affiliated with or endorsed by Riot Games. League of Legends is a trademark of Riot Games, Inc.</footer>
</body>
</html>`);
});

// Health
app.get('/status', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Keep-alive ping every 14 min so Render free tier doesn't sleep
setInterval(() => {
  fetch('https://league-picker-backend.onrender.com/status')
    .then(() => console.log('Keep-alive ping sent'))
    .catch(() => {});
}, 14 * 60 * 1000);

app.listen(PORT, () => console.log(`League Picker API server running on port ${PORT}`));
