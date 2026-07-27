const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const prisma = require('../config/db');
const s3Service = require('../services/s3Service');
const zoomService = require('../services/zoomService');
const { sendGoogleReviewRequestWhatsApp } = require('../services/whatsappService');
const { communicationsQueue, remindersQueue } = require('../queues/queueSetup');
const { processPaymentEvent } = require('../services/paymentService');

const processedMessages = new Set();

const isDuplicateMessage = async (messageId) => {
  if (!messageId) return false;

  // 1. Check in-memory Set for local deduplication
  if (processedMessages.has(messageId)) {
    return true;
  }
  processedMessages.add(messageId);
  setTimeout(() => {
    processedMessages.delete(messageId);
  }, 60000); // 1 minute window

  // 2. If Redis is enabled, check Redis for distributed locking/deduplication
  if (process.env.DISABLE_REDIS !== 'true') {
    try {
      const { connection: redis } = require('../queues/connection');
      if (redis && typeof redis.set === 'function') {
        const lockKey = `webhook:msg:${messageId}`;
        const result = await redis.set(lockKey, 'processed', 'EX', 120, 'NX'); // 2 minutes TTL
        if (result !== 'OK') {
          return true; // Key already existed, so it is a duplicate
        }
      }
    } catch (err) {
      console.warn('Deduplication Redis check failed:', err.message);
    }
  }

  // 3. Check Database
  try {
    const existing = await prisma.communicationLog.findFirst({
      where: { messageId }
    });
    if (existing) {
      return true;
    }
  } catch (err) {
    console.warn('Deduplication DB check failed:', err.message);
  }

  return false;
};

exports.verifyMetaSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;
  
  if (!appSecret) {
    console.warn('META_APP_SECRET not configured. Skipping signature validation.');
    return next();
  }

  if (!signature) {
    return res.status(401).send('No signature provided');
  }

  const payload = JSON.stringify(req.body);
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(payload)
    .digest('hex')}`;

  if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return next();
  }
  
  return res.status(401).send('Invalid signature');
};

exports.handleMetaWebhook = async (req, res) => {
  const payload = req.body;
  console.log('Received Meta Webhook:', JSON.stringify(payload, null, 2));

  // Meta requires a 200 OK immediately
  res.status(200).send('EVENT_RECEIVED');

  try {
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // 1. Check if WhatsApp Webhook Message
    if (value?.messages && value.messages.length > 0) {
      for (const msg of value.messages) {
        if (msg.from) {
          const phone = msg.from;
          const contact = value.contacts?.find(c => c.wa_id === phone);
          const name = contact?.profile?.name || 'Applicant';
          const message = msg.text?.body || '';
          const messageId = msg.id;

          if (messageId && await isDuplicateMessage(messageId)) {
            console.log(`[Meta Webhook] WhatsApp message ${messageId} is duplicate. Ignoring.`);
            continue;
          }

          console.log(`Enqueuing WhatsApp message from ${phone} (${name}): ${message}`);
          await communicationsQueue.add('process-meta-message', {
            phone,
            name,
            message,
            messageId,
            platform: 'whatsapp'
          }, {
            jobId: messageId || Date.now().toString()
          });
        }
      }
    } 
    // 2. Messenger / Instagram DM Webhooks
    else if (entry?.messaging && entry.messaging.length > 0) {
      for (const msg of entry.messaging) {
        const senderId = msg.sender?.id;
        const messageText = msg.message?.text || '';
        const platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
        const messageId = msg.message?.mid;

        if (messageId && await isDuplicateMessage(messageId)) {
          console.log(`[Meta Webhook] DM message ${messageId} is duplicate. Ignoring.`);
          continue;
        }
        
        console.log(`Enqueuing Direct Message from ${senderId} on ${platform}`);
        await communicationsQueue.add('process-meta-message', {
          phone: senderId,
          name: `Meta User (${platform === 'instagram' ? 'Instagram' : 'Messenger'})`,
          message: messageText,
          messageId,
          platform
        }, {
          jobId: messageId || Date.now().toString()
        });
      }
    }
    // 3. Comments (Facebook Feed / Instagram Comments) Webhooks
    else if (entry?.changes && entry.changes.length > 0) {
      for (const chg of entry.changes) {
        const val = chg.value;
        const field = chg.field;
        
        if (field === 'feed' || field === 'comments' || field === 'comment') {
          const commentText = val.message || val.text || '';
          const commentId = val.comment_id || val.id;
          const senderName = val.from?.name || 'Social User';
          const platform = payload.object === 'instagram' ? 'instagram' : 'facebook';
          
          if (commentId && await isDuplicateMessage(commentId)) {
            console.log(`[Meta Webhook] Comment ${commentId} is duplicate. Ignoring.`);
            continue;
          }

          console.log(`Enqueuing Comment update from ${senderName} on ${platform} (${field}): ${commentText}`);
          await communicationsQueue.add('process-meta-comment', {
            commentId,
            senderName,
            message: commentText,
            platform
          }, {
            jobId: commentId || Date.now().toString()
          });
        }
      }
    }
  } catch (error) {
    console.error('Error parsing Meta webhook payload:', error);
  }
};

exports.handleStripeWebhook = async (req, res) => {
  // Stripe requires raw body for signature validation
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (endpointSecret) {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = req.body;
    }
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Return a 200 response to acknowledge receipt of the event
  res.send();

  const session = event.data.object;
  if (event.type === 'checkout.session.completed' && session?.metadata?.type === 'no_show_case_assessment') {
    const clientId = session.metadata.clientId;
    const paymentId = session.metadata.paymentId;
    
    try {
      // Get agent's commission rate
      let snapshotRate = 0;
      const clientWithAgent = await prisma.client.findUnique({
        where: { id: clientId },
        include: { assignedTo: true }
      });
      if (clientWithAgent && clientWithAgent.assignedTo) {
        snapshotRate = clientWithAgent.assignedTo.commissionRate || 0;
      }

      // 1. Update Payment status to Paid
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          status: 'Paid',
          transactionId: session.id,
          paymentMethod: 'Stripe',
          totalPaid: session.amount_total ? session.amount_total / 100 : 262.50,
          commissionRate: snapshotRate
        }
      });

      // 2. Fetch Client and Lead
      const client = await prisma.client.findUnique({
        where: { id: clientId },
        include: { lead: true }
      });

      if (client) {
        // 3. Remove client from blacklistedClient table
        try {
          await prisma.blacklistedClient.deleteMany({
            where: {
              OR: [
                { email: client.email.toLowerCase() },
                { phone: client.phone }
              ]
            }
          });
          console.log(`[Stripe Webhook] Removed client ${client.email} from blacklist`);
        } catch (delErr) {
          console.warn('[Stripe Webhook] Blacklist deletion failed:', delErr.message);
        }

        // 4. Update Client status
        await prisma.client.update({
          where: { id: client.id },
          data: {
            status: 'Payment Received',
            isBlocked: false
          }
        });

        if (client.lead) {
          await prisma.lead.update({
            where: { id: client.lead.id },
            data: {
              status: 'Payment Received'
            }
          });
        }

        // 5. Generate secure JWT token for pre-filled re-booking
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || 'secret123';
        const prefillToken = jwt.sign(
          { clientId: client.id, leadId: client.lead?.id },
          secret,
          { expiresIn: '2d' } // Link valid for 2 days
        );

        // 6. Construct re-booking link
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const rebookLink = `${frontendUrl}/#/public/booking?token=${prefillToken}`;

        // 7. Dispatch WhatsApp and Email confirmation
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const { sendEmail } = require('../services/emailService');

        const clientName = `${client.firstName} ${client.lastName}`;
        const messageBody = `Hello *${clientName}*,\n\nWe have successfully received your payment of *€250* (plus 5% VAT) for the Professional Case Assessment. 🎉\n\nYour account has been un-blocked. Please click the link below to select your new date & time slot for the 1-to-1 Case Review (your details are pre-filled):\n🔗 ${rebookLink}`;

        await sendCustomWhatsApp(client.phone, messageBody).catch(err => console.error('[Webhook Stripe] Failed to send re-book WA:', err.message));

        await sendEmail({
          to: client.email,
          subject: 'Payment Confirmed - Rebook Your Case Assessment - AAA Business Consultancy',
          html: `
            <h3>Payment Successful</h3>
            <p>Dear ${client.firstName},</p>
            <p>We have successfully received your payment of <strong>€250</strong> (plus 5% VAT) for the Professional Case Assessment.</p>
            <p>Your account has been un-blocked. Please reschedule your One-to-One Case Review session by clicking the link below:</p>
            <p><a href="${rebookLink}">Reschedule Your Consultation Meeting</a></p>
            <p>Thank you for choosing AAA Business Consultancy!</p>
          `
        }).catch(err => console.error('[Webhook Stripe] Failed to send re-book email:', err.message));

        // Schedule Phase 7 Drips & Google Review if remindersQueue is active
        const { remindersQueue } = require('../queues/queueSetup');
        if (remindersQueue && remindersQueue.add) {
          // 1. Schedule Upgrade drips (3d, 7d, 10d, 14d)
          await remindersQueue.add('paid-assessment-upgrade-drip', { clientId: client.id, dripIndex: 1 }, { delay: 3 * 24 * 60 * 60 * 1000 });
          await remindersQueue.add('paid-assessment-upgrade-drip', { clientId: client.id, dripIndex: 2 }, { delay: 7 * 24 * 60 * 60 * 1000 });
          await remindersQueue.add('paid-assessment-upgrade-drip', { clientId: client.id, dripIndex: 3 }, { delay: 10 * 24 * 60 * 60 * 1000 });
          await remindersQueue.add('paid-assessment-upgrade-drip', { clientId: client.id, dripIndex: 4 }, { delay: 14 * 24 * 60 * 60 * 1000 });

          // 2. Schedule Google Review request drip (3d)
          await remindersQueue.add('google-review-request-drip', { clientId: client.id }, { delay: 3 * 24 * 60 * 60 * 1000 });
          console.log(`[Stripe Webhook] Scheduled Phase 7 upgrade drips and Google review request for client ${client.id}`);
        }
      }

    } catch (err) {
      console.error('Error handling no_show_case_assessment webhook event:', err);
    }
  } else {
    // Enqueue payment event (We can handle this later in Payment State Machine)
    await processPaymentEvent(event).catch(console.error);
  }
};

exports.handleTikTokWebhook = async (req, res) => {
  const payload = req.body;
  res.status(200).send('EVENT_RECEIVED');
  
  await communicationsQueue.add('process-tiktok-lead', payload, {
    jobId: payload.lead_id || Date.now().toString(),
  });
};

exports.handleTelegramWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log('Received Telegram Webhook Payload:', JSON.stringify(payload, null, 2));

    // Acknowledge event immediately to Telegram
    res.status(200).json({ success: true });

    const message = payload.message;
    if (message && message.text) {
      const chatId = String(message.chat.id);
      const text = message.text;
      const firstName = message.from?.first_name || '';
      const lastName = message.from?.last_name || '';
      const name = `${firstName} ${lastName}`.trim() || 'Telegram User';

      console.log(`Enqueuing Telegram message from chat ${chatId}: ${text}`);
      await communicationsQueue.add('process-telegram-message', {
        chatId,
        name,
        message: text
      }, {
        jobId: `tg-${message.message_id || Date.now()}`
      });
    }
  } catch (err) {
    console.error('Error handling Telegram webhook:', err);
  }
};

exports.verifyMetaWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_VERIFY_TOKEN || 'aaa_consultancy_secret_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === verifyToken) {
      console.log('Meta Webhook Verified Successfully!');
      return res.status(200).send(challenge);
    } else {
      console.warn('Meta Webhook Verification Failed: Token Mismatch');
      return res.status(403).send('Forbidden');
    }
  }
  return res.status(400).send('Bad Request');
};

/**
 * Background worker logic to extract Zoom cloud recording share link
 * and link it to the matching Consultation in the database.
 */
async function processZoomRecording(requestBody) {
  const zoomPayload = requestBody.payload;
  if (!zoomPayload || !zoomPayload.object) {
    console.error('Invalid Zoom payload structure:', JSON.stringify(requestBody));
    return;
  }
  const meetingId = zoomPayload.object.id;
  
  // Extract Zoom Cloud Share URL or fallback to the play URL of the first file
  const shareUrl = zoomPayload.object.share_url || zoomPayload.object.recording_files?.[0]?.play_url;
  
  if (!shareUrl) {
    console.warn(`No share_url or play_url found for Zoom meeting ${meetingId}`);
    return;
  }
  
  console.log(`Received Zoom recording share URL for meeting ${meetingId}: ${shareUrl}`);
  
  try {
    // Update matching Consultation record in database
    const consultation = await prisma.consultation.findFirst({
      where: {
        meetingLink: {
          contains: meetingId.toString()
        }
      },
      include: {
        lead: true
      }
    });
    
    if (consultation) {
      console.log(`Found Consultation ID ${consultation.id} for Zoom Meeting ${meetingId}. Saving recordingUrl.`);
      
      // 1. Update Consultation record status and recording link
      await prisma.consultation.update({
        where: { id: consultation.id },
        data: {
          recordingUrl: shareUrl,
          status: 'Completed'
        }
      });

      // 2. Append recording link to the associated Lead notes if present
      if (consultation.lead) {
        const lead = consultation.lead;
        const currentLeadNotes = lead.notes || '';
        const appendMsg = `\n\n[Zoom Recording - Completed]: ${shareUrl}`;
        
        await prisma.lead.update({
          where: { id: lead.id },
          data: { notes: currentLeadNotes + appendMsg }
        });

        // 3. Append to Client profileSummary if lead is linked to a Client
        if (lead.clientId) {
          const client = await prisma.client.findUnique({
            where: { id: lead.clientId }
          });
          if (client) {
            const currentProfileSummary = client.profileSummary || '';
            await prisma.client.update({
              where: { id: lead.clientId },
              data: { profileSummary: currentProfileSummary + appendMsg }
            });
          }
        }

        // 4. Log a Communication History entry under the Client/Lead
        await prisma.communicationLog.create({
          data: {
            clientId: lead.clientId || null,
            phone: lead.phone || null,
            name: `${lead.firstName} ${lead.lastName}`.trim(),
            channel: 'MEETING',
            direction: 'OUTBOUND',
            deliveryStatus: 'SENT',
            content: `Zoom Cloud Recording Completed. Meeting: ${consultation.type || 'Eligibility Assessment'} | Date: ${consultation.date} | Link: ${shareUrl}`,
          }
        });
        console.log(`[processZoomRecording] Successfully linked recording link to Lead ${lead.id} notes and communication logs.`);
      }

      // 5. Trigger automated post-consultation Google Review WhatsApp message (Immediate + 3d + 7d drips)
      (async () => {
        try {
          const targetPhone = consultation.lead?.phone;
          const targetName = consultation.lead ? `${consultation.lead.firstName} ${consultation.lead.lastName}`.trim() : 'Client';
          const targetClientId = consultation.lead?.clientId;

          await sendGoogleReviewRequestWhatsApp({
            phone: targetPhone,
            clientName: targetName,
            clientId: targetClientId,
            leadId: consultation.leadId
          });

          if (remindersQueue && remindersQueue.add) {
            await remindersQueue.add('google-review-request-drip', {
              leadId: consultation.leadId,
              clientId: targetClientId,
              phone: targetPhone,
              clientName: targetName,
              dripIndex: 2
            }, {
              delay: 3 * 24 * 60 * 60 * 1000 // 3 days
            });

            await remindersQueue.add('google-review-request-drip', {
              leadId: consultation.leadId,
              clientId: targetClientId,
              phone: targetPhone,
              clientName: targetName,
              dripIndex: 3
            }, {
              delay: 7 * 24 * 60 * 60 * 1000 // 7 days
            });
            console.log(`[Zoom Recording Complete] Scheduled 3-day and 7-day Google Review drips for lead ${consultation.leadId}`);
          }
        } catch (gErr) {
          console.error('[processZoomRecording] Error triggering Google Review WhatsApp sequence:', gErr.message);
        }
      })();
    } else {
      console.warn(`No Consultation record found matching Zoom Meeting ID ${meetingId}`);
    }
  } catch (err) {
    console.error(`Error saving Zoom recording link for meeting ${meetingId}:`, err.message);
  }
}

/**
 * Express Controller Action for Zoom Webhooks.
 * Handles URL validation challenge and async recording processing.
 */
exports.handleZoomWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log('Received Zoom Webhook event:', payload.event);

    // 1. Zoom Webhook URL Validation Challenge
    if (payload.event === 'endpoint.url_validation') {
      const plainToken = payload.payload.plainToken;
      const zoomWebhookToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || 'your_zoom_webhook_secret_token_here';
      
      const encryptedToken = crypto
        .createHmac('sha256', zoomWebhookToken)
        .update(plainToken)
        .digest('hex');
        
      console.log('Responding to Zoom URL Validation Challenge');
      return res.status(200).json({
        plainToken,
        encryptedToken
      });
    }

    // 2. Zoom Cloud Recording Completion Event
    if (payload.event === 'recording.completed') {
      // Respond 200 OK immediately to satisfy Zoom's 3-second timeout constraint
      res.status(200).send('OK');
      
      // Process file download and upload in background
      processZoomRecording(payload).catch(err => {
        console.error('Background Zoom recording processing failed:', err.message);
      });
      return;
    }

    // Unhandled event
    return res.status(200).send('EVENT_IGNORED');
  } catch (error) {
    console.error('Error in Zoom webhook handler:', error.message);
    return res.status(500).send('Internal Server Error');
  }
};

/**
 * Twilio Webhook Handler (Inbound WhatsApp messages)
 * Twilio sends URL-encoded POST payloads when a user replies to your WhatsApp number.
 */
exports.handleTwilioWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log('Received Twilio Webhook Payload:', payload);

    // Twilio webhooks must return TwiML (XML) response, even an empty one is fine
    res.type('text/xml');
    res.send('<Response></Response>');

    // Extract message fields
    const rawFrom = payload.From || ''; // Format: "whatsapp:+1234567890" or "+1234567890"
    const phone = rawFrom.replace('whatsapp:', '');
    const message = payload.Body || '';
    const name = payload.ProfileName || ''; // Twilio ProfileName if available
    const messageId = payload.MessageSid;
    
    // Extract media if present
    const numMedia = parseInt(payload.NumMedia || '0', 10);
    const mediaUrl = numMedia > 0 ? payload.MediaUrl0 : null;

    // Deduplicate incoming Twilio messages
    if (messageId && await isDuplicateMessage(messageId)) {
      console.log(`[Twilio Webhook] Message ${messageId} is duplicate. Ignoring.`);
      return;
    }

    if (phone) {
      // Broadcast live via Socket.io
      const io = req.app.get('io');
      if (io) {
        io.emit('new_whatsapp_message', {
          phone: phone,
          name: (name && name !== 'Applicant') ? name : phone,
          text: message,
          mediaUrl: mediaUrl,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }

      if (process.env.DISABLE_REDIS === 'true') {
        console.log(`[LOCAL DEV] Redis disabled. Processing chatbot message synchronously.`);
        const chatbotService = require('../services/chatbotService');
        chatbotService.handleChatbotMessage(phone, name || 'Applicant', message || '', messageId, mediaUrl).catch(err => {
          console.error('[LOCAL DEV] Chatbot processing error:', err.message);
        });
      } else {
        // Add incoming message to communications queue
        await communicationsQueue.add('process-twilio-message', {
          phone,
          name,
          message,
          messageId,
          mediaUrl,
          rawPayload: payload
        }, {
          jobId: messageId || `twilio-msg-${Date.now()}`
        });
        console.log(`Enqueued incoming Twilio WhatsApp message job from ${phone}`);
      }
    }
  } catch (error) {
    console.error('Error handling Twilio webhook:', error.message);
    // Don't crash, respond with empty TwiML
    if (!res.headersSent) {
      res.type('text/xml');
      res.send('<Response></Response>');
    }
  }
};

/**
 * Express Controller Action for Zoho Invoice Webhooks.
 * Receives payment completion & invoice status updates from Zoho Invoice API.
 */
exports.handleZohoWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('Received Zoho Webhook payload:', JSON.stringify(payload, null, 2));

    // Respond 200 OK to Zoho immediately
    res.status(200).send('OK');

    const invoice = payload.invoice || payload.event_data?.invoice;
    const payment = payload.payment || payload.event_data?.payment;
    const invoiceId = invoice?.invoice_id || payment?.invoice_id || payload.invoice_id;
    const eventType = payload.event_type || payload.event;
    const status = (invoice?.status || payload.status || '').toLowerCase();

    if (status === 'paid' || eventType === 'payment.created' || eventType === 'invoice.status_changed') {
      if (invoiceId) {
        const paymentRecord = await prisma.payment.findFirst({
          where: {
            OR: [
              { gatewayId: invoiceId },
              { id: invoiceId }
            ]
          },
          include: { client: true }
        });

        if (paymentRecord && paymentRecord.status !== 'Paid') {
          await prisma.payment.update({
            where: { id: paymentRecord.id },
            data: {
              status: 'Paid',
              paymentMethod: 'ZOHO_STRIPE',
              transactionId: payment?.payment_id || `zoho-tx-${Date.now()}`
            }
          });

          if (paymentRecord.clientId) {
            await prisma.client.update({
              where: { id: paymentRecord.clientId },
              data: {
                status: 'Payment Received',
                visaStatus: 'Document Preparation',
                documentUploadAllowed: true
              }
            });
            console.log(`[Zoho Webhook] Payment ${paymentRecord.id} for client ${paymentRecord.clientId} updated to Paid.`);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error handling Zoho webhook:', error.message);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
};

