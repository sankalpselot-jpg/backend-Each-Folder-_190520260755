/**
 * services/emailService.js
 * 
 * Email notifications via SendGrid.
 * Handles: registration confirmation, admin approval/rejection,
 * inquiry notifications, and password reset.
 * 
 * All email templates are defined here as functions returning HTML strings.
 */

const sgMail = require('@sendgrid/mail');
const logger = require('../utils/logger');

// Initialize SendGrid with API key
// Only initialize SendGrid if API key is properly configured
if (process.env.SENDGRID_API_KEY && process.env.SENDGRID_API_KEY.startsWith("SG.")) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.warn("SendGrid API key not configured - emails will be disabled");
}

const FROM = {
  email: process.env.FROM_EMAIL,
  name: process.env.FROM_NAME || 'BoothMarket',
};

// ─── Generic Send Helper ──────────────────────────────────────────────────────
/**
 * Internal helper — wraps SendGrid send with error handling.
 * Never throws — logs errors and returns false so app doesn't crash on email failure.
 */
const sendEmail = async ({ to, subject, html }) => {
  try {
    await sgMail.send({ from: FROM, to, subject, html });
    logger.info(`Email sent: "${subject}" → ${to}`);
    return true;
  } catch (err) {
    // Log full error details for debugging but don't propagate
    logger.error('SendGrid error:', {
      message: err.message,
      code: err.code,
      response: err.response?.body,
    });
    return false;
  }
};

// ─── Email Templates ──────────────────────────────────────────────────────────
// Inline styles used because many email clients strip <style> tags

const baseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
          <tr>
            <td style="background:#1a1a2e;padding:24px 40px;">
              <h1 style="color:#e94560;margin:0;font-size:24px;">BoothMarket</h1>
              <p style="color:#8892a4;margin:4px 0 0;font-size:13px;">B2B Rental Marketplace</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              ${content}
            </td>
          </tr>
          <tr>
            <td style="background:#f9f9f9;padding:20px 40px;text-align:center;">
              <p style="color:#999;font-size:12px;margin:0;">
                © ${new Date().getFullYear()} BoothMarket. All rights reserved.<br>
                Questions? Email <a href="mailto:support@boothmarket.com" style="color:#e94560;">support@boothmarket.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// ─── Public Email Functions ───────────────────────────────────────────────────

/**
 * Sent immediately after registration to confirm receipt.
 * Tells user their account is under admin review.
 */
const sendRegistrationConfirmation = async ({ to, firstName, role }) => {
  const roleLabel = {
    consultant: 'Exhibition Booth Consultant',
    rental_provider: 'Rental Provider',
    company: 'Company / End Customer',
  }[role] || role;

  return sendEmail({
    to,
    subject: 'Your BoothMarket registration is under review',
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">Welcome, ${firstName}!</h2>
      <p style="color:#555;line-height:1.6;">
        Thank you for registering on <strong>BoothMarket</strong> as a <strong>${roleLabel}</strong>.
      </p>
      <p style="color:#555;line-height:1.6;">
        Your account is currently <strong>under review</strong> by our admin team.
        We typically review accounts within 24–48 business hours.
      </p>
      <p style="color:#555;line-height:1.6;">
        You will receive another email once your account is approved (or if we need more information).
      </p>
      <div style="background:#f0f4ff;border-left:4px solid #e94560;padding:16px;margin:24px 0;border-radius:4px;">
        <p style="margin:0;color:#333;font-size:14px;">
          📧 Registered email: <strong>${to}</strong><br>
          👤 Role: <strong>${roleLabel}</strong>
        </p>
      </div>
    `),
  });
};

/**
 * Sent by admin when they click "Approve" on a user account.
 */
const sendApprovalEmail = async ({ to, firstName, role }) => {
  const loginUrl = `${process.env.CLIENT_URL}/login`;

  return sendEmail({
    to,
    subject: '🎉 Your BoothMarket account has been approved!',
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">Great news, ${firstName}!</h2>
      <p style="color:#555;line-height:1.6;">
        Your BoothMarket account has been <strong style="color:#22c55e;">approved</strong>. 
        You can now log in and start using the platform.
      </p>
      ${role === 'rental_provider' ? `
        <p style="color:#555;line-height:1.6;">
          As a <strong>Rental Provider</strong>, you can now list your products 
          (furniture, LED, lighting, etc.) and receive inquiries from consultants.
        </p>
      ` : ''}
      ${role === 'consultant' ? `
        <p style="color:#555;line-height:1.6;">
          As a <strong>Consultant</strong>, you can now browse rental products 
          and send inquiries to rental providers.
        </p>
      ` : ''}
      <div style="text-align:center;margin:32px 0;">
        <a href="${loginUrl}" style="background:#e94560;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">
          Log In to BoothMarket →
        </a>
      </div>
    `),
  });
};

/**
 * Sent by admin when they click "Reject" on a user account.
 * Includes the reason the admin entered.
 */
const sendRejectionEmail = async ({ to, firstName, reason }) => {
  return sendEmail({
    to,
    subject: 'Update on your BoothMarket registration',
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">Hello, ${firstName}</h2>
      <p style="color:#555;line-height:1.6;">
        After reviewing your BoothMarket registration, we were unable to approve 
        your account at this time.
      </p>
      ${reason ? `
        <div style="background:#fff5f5;border-left:4px solid #ef4444;padding:16px;margin:24px 0;border-radius:4px;">
          <p style="margin:0;color:#333;font-size:14px;">
            <strong>Reason provided:</strong><br>
            ${reason}
          </p>
        </div>
      ` : ''}
      <p style="color:#555;line-height:1.6;">
        If you believe this is a mistake or have additional information to share,
        please contact us at 
        <a href="mailto:support@boothmarket.com" style="color:#e94560;">support@boothmarket.com</a>.
      </p>
    `),
  });
};

/**
 * Sent to rental provider when a consultant sends them an inquiry.
 */
const sendInquiryNotificationToProvider = async ({
  to, providerName, consultantName, productTitle, inquiryId,
}) => {
  const inquiryUrl = `${process.env.CLIENT_URL}/dashboard/inquiries/${inquiryId}`;

  return sendEmail({
    to,
    subject: `New inquiry for your product: ${productTitle}`,
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">New Inquiry Received</h2>
      <p style="color:#555;line-height:1.6;">
        Hello <strong>${providerName}</strong>,
      </p>
      <p style="color:#555;line-height:1.6;">
        <strong>${consultantName}</strong> has sent an inquiry for your product:
        <strong>${productTitle}</strong>.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${inquiryUrl}" style="background:#e94560;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">
          View & Respond to Inquiry →
        </a>
      </div>
      <p style="color:#999;font-size:13px;">Please respond within 48 hours to maintain your response rate.</p>
    `),
  });
};

/**
 * Sent to consultant when provider responds to their inquiry.
 */
const sendInquiryResponseToConsultant = async ({
  to, consultantName, providerName, productTitle, inquiryId, status,
}) => {
  const inquiryUrl = `${process.env.CLIENT_URL}/dashboard/inquiries/${inquiryId}`;
  const statusLabel = status === 'accepted' ? '✅ Accepted' : '❌ Declined';

  return sendEmail({
    to,
    subject: `Inquiry ${status}: ${productTitle}`,
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">Inquiry Update</h2>
      <p style="color:#555;line-height:1.6;">
        Hello <strong>${consultantName}</strong>,
      </p>
      <p style="color:#555;line-height:1.6;">
        <strong>${providerName}</strong> has responded to your inquiry for 
        <strong>${productTitle}</strong>: <strong>${statusLabel}</strong>
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${inquiryUrl}" style="background:#e94560;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">
          View Full Response →
        </a>
      </div>
    `),
  });
};

/**
 * Password reset email with one-time link.
 */
const sendPasswordResetEmail = async ({ to, firstName, resetToken }) => {
  const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;

  return sendEmail({
    to,
    subject: 'Reset your BoothMarket password',
    html: baseTemplate(`
      <h2 style="color:#1a1a2e;margin-top:0;">Password Reset Request</h2>
      <p style="color:#555;line-height:1.6;">
        Hello <strong>${firstName}</strong>, we received a request to reset your password.
      </p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${resetUrl}" style="background:#e94560;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">
          Reset My Password →
        </a>
      </div>
      <p style="color:#999;font-size:13px;">
        This link expires in 1 hour. If you didn't request this, ignore this email — 
        your password will not change.
      </p>
    `),
  });
};

module.exports = {
  sendRegistrationConfirmation,
  sendApprovalEmail,
  sendRejectionEmail,
  sendInquiryNotificationToProvider,
  sendInquiryResponseToConsultant,
  sendPasswordResetEmail,
};
