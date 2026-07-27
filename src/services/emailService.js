const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT == 465;
const SMTP_FROM = process.env.SMTP_FROM || `"AAA Business Consultancy" <info@aaabusinessconsultancy.com>`;

let resendClient = null;
let transporter = null;

if (RESEND_API_KEY && RESEND_API_KEY !== 'your_resend_api_key_here') {
  console.log('Email Service: Initializing Resend client');
  resendClient = new Resend(RESEND_API_KEY);
} else if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  console.log(`Email Service: Initializing SMTP transporter to ${SMTP_HOST}:${SMTP_PORT}`);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
} else {
  console.warn('Email Service: Neither Resend nor SMTP credentials configured. Running in local DRY-RUN/Sandbox mode.');
}

/**
 * Sends an email using Resend, SMTP, or prints to logs if neither is configured (dry-run).
 * @param {Object} options - Email sending options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body fallback
 * @returns {Promise<{success: boolean, messageId?: string, dryRun?: boolean}>}
 */
exports.sendEmail = async ({ to, subject, html, text }) => {
  if (resendClient) {
    try {
      const fromAddress = RESEND_FROM || SMTP_FROM;
      const response = await resendClient.emails.send({
        from: fromAddress,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Basic HTML strip for fallback text
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      console.log(`Email sent successfully via Resend to ${to}. Message ID: ${response.data?.id}`);
      return { success: true, messageId: response.data?.id, dryRun: false };
    } catch (error) {
      console.error(`Failed to send email via Resend to ${to}:`, error);
      throw error;
    }
  } else if (transporter) {
    try {
      const info = await transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        text: text || html.replace(/<[^>]*>/g, ''), // Basic HTML strip for fallback text
        html
      });
      console.log(`Email sent successfully via SMTP to ${to}. Message ID: ${info.messageId}`);
      return { success: true, messageId: info.messageId, dryRun: false };
    } catch (error) {
      console.error(`Failed to send email via SMTP to ${to}:`, error);
      throw error;
    }
  } else {
    // Sandbox / Dry-Run Log
    const fromAddress = RESEND_FROM || SMTP_FROM;
    console.log('------------------------------------------------------------');
    console.log(`[EMAIL DRY-RUN (NOT CONFIGURED)]`);
    console.log(`From:    ${fromAddress}`);
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body (Preview): ${html.substring(0, 150)}...`);
    console.log('------------------------------------------------------------');
    return { success: true, messageId: `dryrun-${Date.now()}`, dryRun: true };
  }
};

/**
 * Sends a customized Spain Visa checklist to the client upon successful payment.
 * @param {string} to - Client email
 * @param {string} clientName - Client's name
 * @param {string} serviceType - Service type/visa selected
 */
exports.sendVisaChecklist = async (to, clientName, serviceType) => {
  const normalizedService = (serviceType || '').toLowerCase();
  let checklistTitle = "Spain Visa Document Checklist";
  let checklistHtml = `
    <li>Valid Passport (original and copy of all pages)</li>
    <li>Proof of clean criminal record (duly apostilled)</li>
    <li>Visa application form duly filled and signed</li>
    <li>Recent passport-size photographs</li>
    <li>Proof of healthcare coverage in Spain</li>
  `;

  if (normalizedService.includes('nomad') || normalizedService.includes('dnv')) {
    checklistTitle = "Spain Digital Nomad Visa (DNV) Checklist";
    checklistHtml = `
      <li><b>Passport:</b> Valid passport with at least 1 year validity and copies of all pages.</li>
      <li><b>Employment Certificate:</b> Document proving relationship with foreign employers for at least 3 months.</li>
      <li><b>Company Legitimacy:</b> Certificate of Incorporation/Business Registry of your employer.</li>
      <li><b>Proof of Income:</b> Bank statements or invoices showing at least €2,646 per month (200% of SMI).</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background check from country of residence for last 5 years.</li>
      <li><b>Degree/Experience:</b> University degree/diploma or proof of 3+ years professional experience.</li>
      <li><b>Private Health Insurance:</b> Spanish health insurance policy (no copay, no waiting period).</li>
    `;
  } else if (normalizedService.includes('lucrative') || normalizedService.includes('nlv')) {
    checklistTitle = "Spain Non-Lucrative Visa (NLV) Checklist";
    checklistHtml = `
      <li><b>Passport:</b> Valid passport with at least 1 year validity and copies of all pages.</li>
      <li><b>Sufficient Financial Means:</b> Proof of passive income or savings showing at least €28,800 annually (400% of IPREM).</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background check from last 5 years.</li>
      <li><b>Private Health Insurance:</b> Comprehensive Spanish health insurance (no copay).</li>
      <li><b>Medical Certificate:</b> Form stating you do not suffer from diseases that pose public health risks.</li>
    `;
  } else if (normalizedService.includes('tourist') || normalizedService.includes('schengen')) {
    checklistTitle = "Spain Schengen Tourist Visa Checklist";
    checklistHtml = `
      <li><b>Schengen Visa Form:</b> Fully completed and signed application form.</li>
      <li><b>Travel Insurance:</b> Coverage of at least €30,000 for medical expenses inside Schengen zone.</li>
      <li><b>Flight & Hotel Booking:</b> Confirmed return ticket reservation and accommodation details.</li>
      <li><b>Proof of Funds:</b> Bank statements showing at least €108 per day of stay in Spain.</li>
      <li><b>Employment Status:</b> Reference letter from current employer or business license copy.</li>
    `;
  } else if (normalizedService.includes('study') || normalizedService.includes('student')) {
    checklistTitle = "Spain Student Visa Checklist";
    checklistHtml = `
      <li><b>Letter of Acceptance:</b> Official admission letter from accredited Spanish educational institution.</li>
      <li><b>Proof of Funds:</b> Financial resources showing at least €600 per month (100% of IPREM).</li>
      <li><b>Medical Certificate:</b> Proof of good health (for stays longer than 180 days).</li>
      <li><b>Criminal Record Certificate:</b> Clean record certificate from last 5 years (for stays longer than 180 days).</li>
      <li><b>Private Spanish Health Insurance:</b> Coverage for student stay.</li>
    `;
  } else if (normalizedService.includes('self') || normalizedService.includes('business') || normalizedService.includes('employed')) {
    checklistTitle = "Spain Self-Employed / Business Residency Checklist";
    checklistHtml = `
      <li><b>Business Plan:</b> Detailed business plan approved by official Spanish trade organizations.</li>
      <li><b>Professional Qualification:</b> Proof of qualifications/license required to run your business.</li>
      <li><b>Proof of Investment:</b> Sufficient capital setup and funding commitments in Spain.</li>
      <li><b>Criminal Record Certificate:</b> Apostilled clean background certificate from last 5 years.</li>
      <li><b>Private Health Insurance:</b> Spanish private health coverage.</li>
    `;
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
      <h2 style="color: #1a56db; text-align: center;">AAA Business Consultancy</h2>
      <p>Dear <b>${clientName}</b>,</p>
      <p>Thank you for choosing AAA Business Consultancy. We have successfully received your payment. Your Spanish visa relocation folder has been created.</p>
      <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 15px 0;">
        <h3 style="margin-top: 0; color: #1f2937;">📋 ${checklistTitle}</h3>
        <p>Please gather the following documents and upload them through your client dashboard:</p>
        <ul style="line-height: 1.6; padding-left: 20px;">
          ${checklistHtml}
        </ul>
      </div>
      <p>You can access your secure documents portal to begin uploading these files: <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents" style="color: #1a56db; text-weight: bold;">Upload Portal Link</a></p>
      <br>
      <p>Best regards,</p>
      <p><b>AAA Business Consultancy Team</b></p>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `[Checklist] Required Documents for your Spain ${serviceType || 'Visa'} Application 🇪🇸`,
    html
  });
};

/**
 * Sends branded Appointment Confirmation email with Reschedule, Cancel, and Packages action buttons.
 */
exports.sendAppointmentConfirmationEmail = async ({ to, firstName, date, timeSlot, meetingLink, consultationId }) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const joinUrl = meetingLink || 'https://zoom.us';
  const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultationId || ''}`;
  const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultationId || ''}`;
  const packagesUrl = `${frontendUrl}/#/portal/login`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.8;">Spain Visa & Residency Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #2d3748; margin-top: 0; font-size: 18px;">✈️ Appointment Confirmation</h3>
        <p style="color: #4a5568; line-height: 1.6;">Dear <b>${firstName}</b>,</p>
        <p style="color: #4a5568; line-height: 1.6;">Thank you for booking your <b>Free 20-Minute Eligibility Assessment</b> with our expert team. Your booking is confirmed.</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">📅 Appointment Details:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Date:</b> ${date}</li>
            <li><b>Time:</b> ${timeSlot} (UTC)</li>
            <li><b>Duration:</b> 20 Minutes</li>
            <li><b>Meeting Link:</b> <a href="${joinUrl}" style="color: #2563eb; font-weight: 600;">Click to Join Zoom Meeting</a></li>
          </ul>
        </div>

        <div style="text-align: center; margin: 24px 0;">
          <a href="${joinUrl}" style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">🎥 Join Zoom Meeting</a>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />

        <h4 style="color: #334155; margin-bottom: 12px; font-size: 14px;">⚙️ Manage Your Booking:</h4>
        <div style="margin-bottom: 20px;">
          <a href="${rescheduleUrl}" style="display: inline-block; padding: 10px 18px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">🔄 Reschedule Appointment</a>
          <a href="${cancelUrl}" style="display: inline-block; padding: 10px 18px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-right: 8px; margin-bottom: 8px;">❌ Cancel Appointment</a>
          <a href="${packagesUrl}" style="display: inline-block; padding: 10px 18px; background-color: #059669; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px; margin-bottom: 8px;">📦 Explore Service Packages</a>
        </div>

        <p style="font-size: 12px; color: #64748b; line-height: 1.5; background-color: #f1f5f9; padding: 12px; border-radius: 6px;">
          ⚠️ <b>Policy Note:</b> If you do not join your scheduled Free Eligibility Assessment within 10 minutes of the appointment time, your booking will be automatically cancelled.
        </p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `Booking Confirmed: Spain Visa Eligibility Assessment (${date} at ${timeSlot}) ✈️`,
    html
  });
};

/**
 * Sends a branded Invoice & Payment Link Email to the client.
 */
exports.sendInvoiceNotificationEmail = async ({ to, clientName, amount, discount, netAmount, serviceType, checkoutUrl, portalUrl, tempPassword }) => {
  const loginUrl = portalUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
  const paymentLink = checkoutUrl || loginUrl;

  const html = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 620px; margin: auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: linear-gradient(135deg, #0f0c29, #302b63); padding: 24px; text-align: center; color: #ffffff;">
        <h2 style="margin: 0; font-size: 22px; font-weight: 800;">AAA Business Consultancy</h2>
        <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.85;">Spain Relocation & Visa Legal Services</p>
      </div>

      <div style="padding: 28px;">
        <h3 style="color: #1e293b; margin-top: 0; font-size: 18px;">📄 Spain Visa Relocation Invoice & Portal Account</h3>
        <p style="color: #475569; line-height: 1.6;">Dear <b>${clientName}</b>,</p>
        <p style="color: #475569; line-height: 1.6;">Welcome to AAA Business Consultancy! Your relocation folder has been initialized. Please find your invoice details below:</p>

        <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #1e293b; font-size: 15px;">💳 Invoice Summary:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #334155; line-height: 1.8;">
            <li><b>Service Selected:</b> ${serviceType || 'Spain Relocation Legal Package'}</li>
            <li><b>Base Amount:</b> €${Number(amount || 0).toLocaleString()}</li>
            ${discount > 0 ? `<li><b>Discount Applied:</b> -€${Number(discount).toLocaleString()}</li>` : ''}
            <li><b>Total Amount Due:</b> <strong style="color: #2563eb; font-size: 16px;">€${Number(netAmount || amount || 0).toLocaleString()}</strong></li>
          </ul>

          <div style="text-align: center; margin-top: 20px;">
            <a href="${paymentLink}" style="display: inline-block; padding: 12px 26px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 700; font-size: 14px;">💳 Proceed to Secure Stripe Payment</a>
          </div>
        </div>

        ${tempPassword ? `
        <div style="background-color: #f1f5f9; border-left: 4px solid #4f46e5; border-radius: 6px; padding: 16px; margin: 20px 0;">
          <h4 style="margin: 0 0 8px; color: #4f46e5; font-size: 14px;">🔐 Client Portal Access Credentials:</h4>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Portal Link:</b> <a href="${loginUrl}" style="color: #2563eb; font-weight: 600;">Access Portal Here</a></p>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Username:</b> ${to}</p>
          <p style="margin: 4px 0; font-size: 13px; color: #334155;"><b>Temporary Password:</b> <code style="background-color: #ffffff; padding: 2px 8px; border-radius: 4px; border: 1px solid #cbd5e1; font-weight: bold; color: #e11d48;">${tempPassword}</code></p>
          <p style="font-size: 11px; color: #ef4444; margin: 8px 0 0;">* Note: You can also log in to pay directly inside your portal and change your password.</p>
        </div>
        ` : ''}

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
          If you have any questions or require assistance, please reply directly to this email or contact your assigned consultant.
        </p>
      </div>

      <div style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;">
        © 2026 AAA Business Consultancy · All rights reserved
      </div>
    </div>
  `;

  return exports.sendEmail({
    to,
    subject: `Relocation Invoice & Client Portal Account - AAA Business Consultancy 🇪🇸`,
    html
  });
};


