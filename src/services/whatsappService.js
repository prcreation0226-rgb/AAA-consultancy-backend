const twilio = require('twilio');
const prisma = require('../config/db');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

const isConfigured = !!(
  TWILIO_ACCOUNT_SID && 
  TWILIO_ACCOUNT_SID.startsWith('AC') && 
  TWILIO_AUTH_TOKEN && 
  TWILIO_AUTH_TOKEN !== 'your_twilio_auth_token_here' && 
  TWILIO_WHATSAPP_FROM
);

if (isConfigured) {
  console.log(`WhatsApp Service: Twilio WhatsApp API configured with Sender: ${TWILIO_WHATSAPP_FROM}`);
} else {
  console.warn('WhatsApp Service: Twilio credentials not configured (or using placeholders). Running in local DRY-RUN/Sandbox mode.');
}

/**
 * Sends a WhatsApp message using Twilio or logs it in Dry-Run mode.
 * Matches CRM template placeholders (e.g. {{1}}, {{2}}) with parameters in components.
 * 
 * @param {Object} options - Sending options
 * @param {string} options.to - Recipient phone number (e.g., "+971509554142" or "919876543210")
 * @param {string} options.templateName - Registered template ID/name (e.g., "automated_first_response")
 * @param {string} [options.languageCode='en'] - Template language code (legacy parameter for compatibility)
 * @param {Array} [options.components=[]] - Template components containing parameters (header, body, buttons)
 * @returns {Promise<{success: boolean, messageId?: string, dryRun?: boolean}>}
 */
exports.sendWhatsAppMessage = async ({ to, templateName, languageCode = 'en', components = [] }) => {
  // Clean phone number format for Twilio: must start with '+' and be prefixed with 'whatsapp:'
  let cleanTo = to.trim();
  if (cleanTo.startsWith('whatsapp:')) {
    cleanTo = cleanTo.substring(9);
  }
  cleanTo = cleanTo.replace(/[^\d+]/g, ''); // Keep only digits and '+'
  if (!cleanTo.startsWith('+')) {
    cleanTo = '+' + cleanTo;
  }

  // Sandbox Mode Whitelist Filter (Defaults to Active with +917047687998)
  const isTestMode = process.env.TEST_MODE !== 'false'; // Defaults to true
  if (isTestMode) {
    const whitelistStr = process.env.TEST_PHONES || '+917047687998,+971524350123,+971524360123,+971566952566';
    const testPhones = whitelistStr.split(',').map(p => p.trim());
    if (!testPhones.includes(cleanTo)) {
      console.log(`[TEST MODE] Blocked automated template "${templateName}" to ${cleanTo} (not whitelisted)`);
      return { success: true, messageId: 'blocked-sandbox', dryRun: true }; // Drop
    }
  }

  const twilioTo = `whatsapp:${cleanTo}`;

  if (isConfigured) {
    try {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

      // 1. Attempt to fetch template from CRM database
      let templateText = null;
      try {
        const template = await prisma.template.findUnique({
          where: { id: templateName }
        });
        if (template && template.body) {
          templateText = template.body;
        }
      } catch (dbError) {
        console.warn(`Could not fetch template "${templateName}" from database, using hardcoded fallback:`, dbError.message);
      }

      // 2. Default fallback values for CRM system templates
      if (!templateText) {
        const fallbacks = {
          automated_first_response: 'Thank you for contacting AAA Business Consultancy regarding Spain Visa & Residency Services. To Book Your Free Eligibility Assessment & Verification Please Contact Us on Whatsapp: https://wa.me/971509554142?text=I%20want%20to%20book%20an%20assessment%20from%20TikTok',
          consultation_scheduled_confirmation: 'Hello {{1}}, your Spain Visa Consultation is scheduled on {{2}} at {{3}} (UTC). Join Zoom Meeting: {{4}}',
          consultation_no_show_cancelled: 'Hello {{1}}, your Free Eligibility Assessment has been cancelled because you did not join within 10 minutes of the scheduled time. Due to high demand, missed appointments cannot be rescheduled.',
          payment_pending_reminder: 'Hi {{1}}, this is a reminder that payment is pending for Invoice #{{2}}.',
          payment_drip_discount: 'Hello {{1}}, use discount code CEO24H to complete your payment for Invoice #{{2}} with a special discount! Valid for 24 hours only.',
          google_review: 'Hello {{1}},\n\nWe hope your consultation with AAA Business Consultancy was helpful! 🇪🇸\n\nIf you enjoyed your experience with our advisors, could you please spare 30 seconds to share your feedback on Google? Your review means the world to us and helps others find us.\n\n⭐ Leave your Google Review here:\nhttps://g.page/r/CXugL6bqOJCXEAI/review\n\nThank you so much for your support!'
        };
        templateText = fallbacks[templateName] || `Template: ${templateName}`;
      }

      // 3. Extract parameter values from 'components' structure
      // Meta API passed variables inside components, e.g.:
      // [{ type: 'body', parameters: [{ type: 'text', text: 'Value1' }, ...] }]
      const bodyComponents = components.find(c => c.type === 'body')?.parameters || [];
      
      // 4. Interpolate variables (replace {{1}} with param 1, {{2}} with param 2, etc.)
      let resolvedBody = templateText;
      bodyComponents.forEach((param, index) => {
        const placeholder = `{{${index + 1}}}`;
        const replacement = param.text || '';
        resolvedBody = resolvedBody.replace(new RegExp(placeholder, 'g'), replacement);
      });

      // 5. Send message via Twilio API
      const message = await client.messages.create({
        body: resolvedBody,
        from: TWILIO_WHATSAPP_FROM,
        to: twilioTo
      });

      console.log(`Twilio WhatsApp message sent successfully using template "${templateName}" to ${twilioTo}. SID: ${message.sid}`);
      return { success: true, messageId: message.sid, dryRun: false };
    } catch (error) {
      console.error(`Failed to send Twilio WhatsApp message to ${twilioTo}:`, error.message);
      throw new Error(`Twilio API Error: ${error.message}`);
    }
  } else {
    // Sandbox / Dry-Run Mode
    console.log('------------------------------------------------------------');
    console.log(`[TWILIO WHATSAPP DRY-RUN]`);
    console.log(`To:       ${twilioTo}`);
    console.log(`Template: ${templateName}`);
    console.log(`Components: ${JSON.stringify(components, null, 2)}`);
    console.log('------------------------------------------------------------');
    return { success: true, messageId: `twilio-dryrun-${Date.now()}`, dryRun: true };
  }
};

/**
 * Sends automated Payment Successful WhatsApp message with receipt details, delivery notice, and portal credentials.
 */
exports.sendPaymentSuccessWhatsApp = async ({ client, paymentId, amount, serviceType, generatedPassword }) => {
  try {
    if (!client || !client.phone) {
      console.warn('[Payment Success WhatsApp] client or client.phone is missing');
      return;
    }

    const receiptId = paymentId ? `#${paymentId.substring(0, 8)}` : `#PAY-${Date.now()}`;

    // Deduplication check: Avoid sending duplicate receipt messages for the same payment
    if (paymentId) {
      const existingLog = await prisma.communicationLog.findFirst({
        where: {
          clientId: client.id,
          content: { contains: receiptId }
        }
      });
      if (existingLog) {
        console.log(`[Payment Success WhatsApp] Receipt ${receiptId} already logged/sent to client ${client.id}. Skipping duplicate.`);
        return;
      }
    }

    const clientName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Valued Client';
    const email = client.email || 'N/A';
    const password = generatedPassword || (client.isTemporaryPassword ? 'Check your registered email' : 'Your registered password');
    const service = serviceType || client.serviceType || 'Spanish Sworn Translation';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const portalUrl = `${frontendUrl}/#/portal/login`;
    const formattedAmount = Number(amount || 0).toFixed(2);

    const messageBody = `🎉 *Payment Successful & Confirmed!*

Dear ${clientName},

Thank you for your payment to AAA Business Consultancy. Your order has been successfully received.

📄 *Payment Receipt Details:*
• Receipt ID: ${receiptId}
• Service: ${service}
• Amount Paid: €${formattedAmount}

⏰ *Delivery Time Notice:*
Maximum delivery time within 7 working days from the date of payment is successfully received.

🔑 *Your Client Portal Login Credentials:*
• Login Portal: ${portalUrl}
• Login ID (Email): ${email}
• Password: ${password}

Please log into your client portal to upload your documents and track your order status in real time.`;

    let cleanPh = String(client.phone || '').trim();
    if (cleanPh.startsWith('whatsapp:')) cleanPh = cleanPh.substring(9);
    cleanPh = cleanPh.replace(/[^\d+]/g, '');
    if (!cleanPh.startsWith('+')) cleanPh = '+' + cleanPh;

    if (!cleanPh || cleanPh === '+') {
      console.warn('[Payment Success WhatsApp] Phone number is empty or invalid:', client.phone);
      return;
    }

    const twilioTo = `whatsapp:${cleanPh}`;
    let deliveryStatus = 'SENT';
    let failureReason = null;

    if (isConfigured) {
      try {
        const clientTwilio = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        await clientTwilio.messages.create({
          body: messageBody,
          from: TWILIO_WHATSAPP_FROM,
          to: twilioTo
        });
        console.log(`[Payment Success WhatsApp] Successfully sent automated receipt & credentials to ${twilioTo}`);
      } catch (err) {
        console.error(`[Payment Success WhatsApp] Twilio send failed to ${twilioTo}:`, err.message);
        deliveryStatus = 'FAILED';
        failureReason = err.message;
      }
    } else {
      console.log('------------------------------------------------------------');
      console.log(`[PAYMENT SUCCESS WHATSAPP DRY-RUN]`);
      console.log(`To: ${twilioTo}`);
      console.log(`Body:\n${messageBody}`);
      console.log('------------------------------------------------------------');
    }

    // Log in CommunicationLog so it appears in Live Chat / Social Inbox
    try {
      await prisma.communicationLog.create({
        data: {
          clientId: client.id,
          phone: cleanPh,
          name: 'System Automated',
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          content: messageBody,
          deliveryStatus: deliveryStatus,
          failureReason: failureReason
        }
      });
    } catch (logErr) {
      console.warn('[Payment Success WhatsApp] Could not log message to CommunicationLog:', logErr.message);
    }
  } catch (globalErr) {
    console.error('[Payment Success WhatsApp Error]:', globalErr.message);
  }
};

/**
 * Sends automated Invoice & Portal Account WhatsApp message.
 */
exports.sendInvoiceWhatsApp = async ({ client, amount, discount, netAmount, serviceType, checkoutUrl, portalUrl, tempPassword }) => {
  try {
    if (!client || !client.phone) {
      console.warn('[Invoice WhatsApp] client or client.phone is missing');
      return;
    }

    let cleanPh = String(client.phone || '').trim();
    if (cleanPh.startsWith('whatsapp:')) cleanPh = cleanPh.substring(9);
    cleanPh = cleanPh.replace(/[^\d+]/g, '');
    if (!cleanPh.startsWith('+')) cleanPh = '+' + cleanPh;

    const digitsOnly = cleanPh.replace(/[^\d]/g, '');
    const searchDigits = digitsOnly.length > 8 ? digitsOnly.slice(-8) : digitsOnly;

    // Deduplication guard: Suppress sending duplicate invoice WhatsApp within 60 seconds
    try {
      const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
      const recentLog = await prisma.communicationLog.findFirst({
        where: {
          phone: { contains: searchDigits },
          createdAt: { gte: oneMinuteAgo },
          content: { contains: 'welcome to AAA Business Consultancy' }
        }
      });

      if (recentLog) {
        console.log(`[Invoice WhatsApp] Suppressed duplicate invoice notification for ${cleanPh} (already sent in last 60s).`);
        return;
      }
    } catch (dedupErr) {
      console.warn('[Invoice WhatsApp] Deduplication check warning:', dedupErr.message);
    }

    let activeTempPassword = tempPassword;
    if (!activeTempPassword && client && client.id) {
      try {
        const bcrypt = require('bcrypt');
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
        let plainPass = '';
        for (let i = 0; i < 8; i++) plainPass += chars.charAt(Math.floor(Math.random() * chars.length));

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(plainPass, salt);

        await prisma.client.update({
          where: { id: client.id },
          data: {
            password: hashedPassword,
            isTemporaryPassword: true
          }
        });

        activeTempPassword = plainPass;
        console.log(`[Invoice WhatsApp] Generated fresh temporary password for client ${client.id}`);
      } catch (passErr) {
        console.warn('[Invoice WhatsApp] Could not auto-generate temp password:', passErr.message);
      }
    }

    if (!activeTempPassword) {
      activeTempPassword = 'Check registered email';
    }

    const { sendCustomWhatsApp } = require('./chatbotService');
    const loginUrl = portalUrl || `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
    const paymentLink = checkoutUrl || loginUrl;
    const clientName = `${client.firstName} ${client.lastName}`.trim();
    const finalPrice = Number(netAmount || amount || 0);

    const message = `Hello *${clientName}*, welcome to AAA Business Consultancy! 🇪🇸\n\nYour Spain Relocation profile has been initialized.\n\n💳 *Invoice Amount:* €${finalPrice.toLocaleString()}\n📌 *Service:* ${serviceType || 'Spain Relocation Legal Package'}\n\n1️⃣ *Pay Invoice (Official Zoho / Payment Link):*\n🔗 ${paymentLink}\n\n2️⃣ *Client Portal Login Credentials:*\n🔗 ${loginUrl}\n👤 *Username:* ${client.email}\n🔑 *Temp Password:* ${activeTempPassword}\n\nThank you for choosing AAA Business Consultancy!`;

    await sendCustomWhatsApp(client.phone, message);
    console.log(`[Invoice WhatsApp] Dispatched single invoice notification to ${client.phone}`);
  } catch (err) {
    console.error('[Invoice WhatsApp] Error dispatching WhatsApp notification:', err.message);
  }
};

/**
 * Sends automated Google Review invitation WhatsApp message post-consultation.
 * Enforces a 14-day phone-number-based deduplication guard using CommunicationLog.
 */
exports.sendGoogleReviewRequestWhatsApp = async ({ phone, clientName, clientId, leadId }) => {
  try {
    if (!phone) {
      console.warn('[Google Review WhatsApp] Missing phone number. Skipping.');
      return { success: false, reason: 'MISSING_PHONE' };
    }

    // Clean phone number format
    let cleanPh = String(phone || '').trim();
    if (cleanPh.startsWith('whatsapp:')) cleanPh = cleanPh.substring(9);
    cleanPh = cleanPh.replace(/[^\d+]/g, '');
    if (!cleanPh.startsWith('+')) cleanPh = '+' + cleanPh;

    if (!cleanPh || cleanPh === '+') {
      console.warn('[Google Review WhatsApp] Phone number is invalid:', phone);
      return { success: false, reason: 'INVALID_PHONE' };
    }

    // Exact requested message content
    const messageBody = `Thank you for choosing AAA Business Consultancy.

We hope you were satisfied with your consultation. We’d truly appreciate it if you could take a moment to leave us a Google Review.

⭐ Leave your review here:

https://g.page/r/CXugL6bqOJCXEAI/review

Thank you for your support!`;

    // Test mode / Whitelist filter
    const isTestMode = process.env.TEST_MODE !== 'false';
    if (isTestMode) {
      const whitelistStr = process.env.TEST_PHONES || '+917047687998,+971524350123,+971524360123,+971566952566';
      const testPhones = whitelistStr.split(',').map(p => p.trim());
      if (!testPhones.includes(cleanPh)) {
        console.log(`[TEST MODE] Blocked Google Review WhatsApp message to ${cleanPh} (not whitelisted)`);
        // Log to database even in test mode so deduplication is recorded
        try {
          await prisma.communicationLog.create({
            data: {
              clientId: clientId || null,
              phone: cleanPh,
              name: clientName || 'Client',
              channel: 'WHATSAPP',
              direction: 'OUTBOUND',
              externalProviderId: 'GOOGLE_REVIEW_REQUEST',
              content: messageBody,
              deliveryStatus: 'LOGGED',
              failureReason: 'TEST_MODE_NOT_WHITELISTED'
            }
          });
        } catch (logErr) {
          console.warn('[Google Review WhatsApp] Test mode log warning:', logErr.message);
        }
        return { success: true, dryRun: true, reason: 'SANDBOX_BLOCKED' };
      }
    }

    const twilioTo = `whatsapp:${cleanPh}`;
    let deliveryStatus = 'SENT';
    let failureReason = null;

    if (isConfigured) {
      try {
        const clientTwilio = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        await clientTwilio.messages.create({
          body: messageBody,
          from: TWILIO_WHATSAPP_FROM,
          to: twilioTo
        });
        console.log(`[Google Review WhatsApp] Successfully sent review request to ${twilioTo}`);
      } catch (err) {
        console.error(`[Google Review WhatsApp] Twilio send failed to ${twilioTo}:`, err.message);
        deliveryStatus = 'FAILED';
        failureReason = err.message;
      }
    } else {
      console.log('------------------------------------------------------------');
      console.log(`[GOOGLE REVIEW WHATSAPP DRY-RUN]`);
      console.log(`To:   ${twilioTo}`);
      console.log(`Body:\n${messageBody}`);
      console.log('------------------------------------------------------------');
    }

    // Record in CommunicationLog
    try {
      let targetClientId = clientId || null;
      if (!targetClientId && leadId) {
        const lead = await prisma.lead.findUnique({
          where: { id: leadId },
          select: { clientId: true }
        });
        if (lead) targetClientId = lead.clientId;
      }

      await prisma.communicationLog.create({
        data: {
          clientId: targetClientId,
          phone: cleanPh,
          name: clientName || 'Client',
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          externalProviderId: 'GOOGLE_REVIEW_REQUEST',
          content: messageBody,
          deliveryStatus: deliveryStatus,
          failureReason: failureReason
        }
      });
    } catch (logErr) {
      console.warn('[Google Review WhatsApp] DB log record warning:', logErr.message);
    }

    return { success: true, dryRun: !isConfigured };
  } catch (err) {
    console.error('[Google Review WhatsApp Error]:', err.message);
    return { success: false, error: err.message };
  }
};



