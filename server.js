import express from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';
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

const MONTHLY_PRICE_ID = 'price_1TgzXHCz5sLysbuTT5VziDxV';
const YEARLY_PRICE_ID  = 'price_1TgzYDCz5sLysbuT5jFxBPoF';

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

function hashVerificationCode(uid, code) {
  const secret = process.env.EMAIL_VERIFICATION_SECRET;
  if (!secret) {
    throw new Error('EMAIL_VERIFICATION_SECRET is not configured');
  }
  return crypto.createHmac('sha256', secret).update(`${uid}:${code}`).digest();
}

async function sendVerificationEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your League Picker verification code',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#102a43">
          <h2>Verify your League Picker email</h2>
          <p>Enter this code in League Picker:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">${code}</div>
          <p>This code expires in 10 minutes. If you did not create an account, you can ignore this email.</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    console.error('Resend email error:', response.status, details);
    throw new Error('Could not send the verification email');
  }
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
