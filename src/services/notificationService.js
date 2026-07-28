const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendWhatsAppMessage } = require('./whatsappService');
const emailService = require('./emailService');

const notifyClient = async ({ event, clientId, consultationId, data = {} }) => {
  try {
    // Resolve Client and Consultation Data
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      include: {
        lead: true
      }
    });

    if (!client) {
      console.error(`[NotificationService] Client not found for clientId: ${clientId}`);
      return;
    }

    const email = client.email || (client.lead ? client.lead.email : null);
    const phone = client.phone || (client.lead ? client.lead.phone : null);
    const firstName = client.firstName || (client.lead ? client.lead.firstName : 'Client');
    const lastName = client.lastName || (client.lead ? client.lead.lastName : '');
    const fullName = `${firstName} ${lastName}`.trim();

    if (!email && !phone) {
      console.warn(`[NotificationService] Missing both email and phone for clientId: ${clientId}`);
      return;
    }

    let consultation = null;
    let date = data.date;
    let time = data.time;
    let link = data.link || 'https://zoom.us';

    if (consultationId) {
      consultation = await prisma.consultation.findUnique({
        where: { id: consultationId }
      });
      if (consultation) {
        date = date || consultation.date;
        time = time || consultation.timeSlot;
        link = link || consultation.meetingLink || 'https://zoom.us';
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    
    // Fallback values
    const safeDate = date || 'TBD';
    const safeTime = time || 'TBD';

    let emailPromise = Promise.resolve();
    let waPromise = Promise.resolve();

    switch (event) {
      case 'MEETING_CANCELLED':
        // WhatsApp mapping
        if (phone) {
          waPromise = sendWhatsAppMessage({
            to: phone,
            templateName: 'meeting_cancelled',
            components: [
              { type: 'body', parameters: [
                { type: 'text', text: fullName },
                { type: 'text', text: safeDate },
                { type: 'text', text: safeTime }
              ]}
            ]
          }).then(res => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_CANCELLED', res))
            .catch(err => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_CANCELLED', { success: false, error: err.message }));
        }
        
        // Email mapping
        if (email) {
          const rebookLink = `${frontendUrl}/#/public/lead-form?id=${client.lead?.id || ''}&rebook=true`;
          emailPromise = emailService.sendMeetingCancelledEmail({
            to: email,
            firstName,
            date: safeDate,
            time: safeTime,
            rebookLink
          }).then(res => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_CANCELLED', { success: true }))
            .catch(err => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_CANCELLED', { success: false, error: err.message }));
        }
        break;

      case 'MEETING_BOOKED':
        if (phone) {
          waPromise = sendWhatsAppMessage({
            to: phone,
            templateName: 'meeting_booked',
            components: [
              { type: 'body', parameters: [
                { type: 'text', text: fullName },
                { type: 'text', text: safeDate },
                { type: 'text', text: safeTime },
                { type: 'text', text: link }
              ]}
            ]
          }).then(res => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_BOOKED', res))
            .catch(err => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_BOOKED', { success: false, error: err.message }));
        }
        
        if (email) {
          const { generateBookingToken } = require('../controllers/consultationController');
          const bToken = consultationId ? generateBookingToken(consultationId) : '';
          const rescheduleLink = `${frontendUrl}/#/public/lead-form?reschedule=true&token=${bToken}&consultationId=${consultationId || ''}`;
          const cancelLink = `${frontendUrl}/#/public/lead-form?cancel=true&token=${bToken}&consultationId=${consultationId || ''}`;
          
          emailPromise = emailService.sendAppointmentConfirmationEmail({
            to: email,
            firstName,
            date: safeDate,
            time: safeTime,
            link,
            rescheduleLink,
            cancelLink
          }).then(res => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_BOOKED', { success: true }))
            .catch(err => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_BOOKED', { success: false, error: err.message }));
        }
        break;
        
      case 'MEETING_RESCHEDULED':
        if (phone) {
          waPromise = sendWhatsAppMessage({
            to: phone,
            templateName: 'meeting_rescheduled',
            components: [
              { type: 'body', parameters: [
                { type: 'text', text: fullName },
                { type: 'text', text: safeDate },
                { type: 'text', text: safeTime },
                { type: 'text', text: link }
              ]}
            ]
          }).then(res => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_RESCHEDULED', res))
            .catch(err => logDelivery(clientId, phone, fullName, 'WHATSAPP', 'MEETING_RESCHEDULED', { success: false, error: err.message }));
        }
        
        if (email) {
          const { generateBookingToken } = require('../controllers/consultationController');
          const bToken = consultationId ? generateBookingToken(consultationId) : '';
          const rescheduleLink = `${frontendUrl}/#/public/lead-form?reschedule=true&token=${bToken}&consultationId=${consultationId || ''}`;
          const cancelLink = `${frontendUrl}/#/public/lead-form?cancel=true&token=${bToken}&consultationId=${consultationId || ''}`;
          emailPromise = emailService.sendMeetingRescheduledEmail({
            to: email,
            firstName,
            date: safeDate,
            time: safeTime,
            link,
            rescheduleLink,
            cancelLink
          }).then(res => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_RESCHEDULED', { success: true }))
            .catch(err => logDelivery(clientId, email, fullName, 'EMAIL', 'MEETING_RESCHEDULED', { success: false, error: err.message }));
        }
        break;
        
      default:
        console.warn(`[NotificationService] Unhandled event type: ${event}`);
    }

    // Execute independently, do not fail transaction if this fails
    await Promise.allSettled([emailPromise, waPromise]);

  } catch (err) {
    console.error(`[NotificationService] Fatal error processing event ${event}:`, err);
  }
};

const logDelivery = async (clientId, recipient, name, channel, eventType, result) => {
  try {
    const isSuccess = result.success;
    let content = `Event: ${eventType}`;
    if (result.dryRun) {
      content += ` (Dry Run/Sandbox)`;
    }
    
    await prisma.communicationLog.create({
      data: {
        clientId: clientId || null,
        phone: channel === 'WHATSAPP' ? recipient : null,
        name: name,
        channel: channel,
        direction: 'OUTBOUND',
        deliveryStatus: isSuccess ? 'SENT' : 'FAILED',
        failureReason: isSuccess ? null : (result.error || 'Unknown Provider Error'),
        content: content
      }
    });
    
    if (!isSuccess) {
      console.error(`[NotificationService] ❌ ${channel} delivery failed for ${recipient}. Reason: ${result.error}`);
    } else {
      console.log(`[NotificationService] ✅ ${channel} delivery logged successfully for ${recipient}`);
    }
  } catch (e) {
    console.error(`[NotificationService] Failed to record CommunicationLog for ${recipient}:`, e.message);
  }
};

module.exports = {
  notifyClient
};
