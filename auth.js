const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET is not set — using an insecure default. Set a real, random JWT_SECRET before deploying.');
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

function signToken(user, workspace) {
  return jwt.sign({ userId: user.id, email: user.email, workspaceId: workspace.id }, JWT_SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

// Sends via Resend (https://resend.com) if RESEND_API_KEY is set. Otherwise, falls
// back to logging the reset link to the server console — lets the whole flow work
// end-to-end locally before you've set up a real email provider.
async function sendPasswordResetEmail(toEmail, resetLink) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[dev] Password reset requested for ${toEmail} — link: ${resetLink}`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Rosebud <onboarding@resend.dev>',
        to: toEmail,
        subject: 'Reset your Rosebud password',
        html: `<p>Someone requested a password reset for your Rosebud account.</p><p><a href="${resetLink}">Click here to set a new password</a>. This link expires in 1 hour.</p><p>If you didn't request this, you can safely ignore this email.</p>`,
      }),
    });
    if (!res.ok) console.error('Resend email failed:', await res.text());
  } catch (err) {
    console.error('Failed to send reset email:', err.message);
  }
}

module.exports = { bcrypt, JWT_SECRET, FRONTEND_URL, signToken, requireAuth, randomToken, sendPasswordResetEmail };
