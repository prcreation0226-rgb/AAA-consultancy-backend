const prisma = require('../config/db');
const zoomService = require('../services/zoomService');
const { sendEmail } = require('../services/emailService');
const { sendWhatsAppMessage, sendGoogleReviewRequestWhatsApp } = require('../services/whatsappService');
const { remindersQueue } = require('../queues/queueSetup');

const getConsultations = async (req, res) => {
  try {
    let whereClause = {};
    if (req.user.role === 'client') {
      const lead = await prisma.lead.findUnique({ where: { clientId: req.user.id } });
      whereClause = {
        OR: [
          { leadId: req.user.id },
          ...(lead ? [{ leadId: lead.id }] : [])
        ]
      };
    }

    const consultations = await prisma.consultation.findMany({
      where: whereClause,
      include: {
        lead: { select: { firstName: true, lastName: true, email: true, clientId: true, preferredLanguage: true } },
        consultant: { select: { fullName: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const mapped = consultations.map(c => {
      let parsedOutcome = null;
      try {
        if (c.eligibility && c.eligibility.startsWith('{')) {
          parsedOutcome = JSON.parse(c.eligibility);
        }
      } catch (e) {}
      
      return {
        ...c,
        outcome: parsedOutcome,
        meetingDate: c.date,
        meetingTime: c.timeSlot,
        assignedAt: c.assignedAt || c.createdAt,
        clientName: c.lead ? `${c.lead.firstName} ${c.lead.lastName}` : 'Unknown',
        clientLanguage: c.lead?.preferredLanguage || 'N/A',
        agentName: c.consultant?.fullName || 'Unassigned',
        assignedConsultantName: c.consultant?.fullName || 'Unassigned',
        assignedConsultantId: c.consultantId
      };
    });
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching consultations' });
  }
};

const createConsultation = async (req, res) => {
  try {
    const { leadId, meetingDate, meetingTime, durationMinutes, assignedConsultantId, notes } = req.body;
    
    // Same-Day Booking Restriction
    if (meetingDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (meetingDate <= todayStr) {
        return res.status(400).json({
          success: false,
          message: 'Booking date must be at least the next calendar day.'
        });
      }
    }

    let meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
    
    if (zoomService.isConfigured) {
      try {
        let startTimeISO = new Date().toISOString();
        if (meetingDate) {
          const timeStr = meetingTime && meetingTime.includes(':') ? meetingTime : '10:00';
          const dateObj = new Date(`${meetingDate}T${timeStr}`);
          if (!isNaN(dateObj.getTime())) {
            startTimeISO = dateObj.toISOString();
          }
        }
        
        const zoomMeeting = await zoomService.createZoomMeeting({
          topic: `Eligibility Assessment for Lead ${leadId || ''}`,
          startTime: startTimeISO,
          durationMinutes: durationMinutes || 30
        });
        
        if (zoomMeeting) {
          meetingLink = zoomMeeting.joinUrl;
        }
      } catch (zoomErr) {
        console.error('Failed to create Zoom meeting, falling back to mock link:', zoomErr.message);
      }
    }
    
    const consultation = await prisma.consultation.create({
      data: {
        leadId,
        date: meetingDate,
        timeSlot: meetingTime,
        durationMinutes: durationMinutes || 30,
        consultantId: assignedConsultantId,
        internalNotes: notes,
        meetingLink
      }
    });

    if (leadId) {
      await prisma.lead.update({
        where: { id: leadId },
        data: { status: 'Meeting Scheduled' }
      }).catch(e => console.warn('Could not update lead status on createConsultation:', e.message));
    }

    // Trigger email, whatsapp, and reminder schedule in the background
    sendConsultationNotifications(consultation).catch(err => console.error('[NOTIFICATIONS] Async error:', err));

    res.status(201).json(consultation);
  } catch (error) {
    console.error('Error booking consultation:', error);
    res.status(500).json({ message: 'Server error booking consultation' });
  }
};

const updateOutcome = async (req, res) => {
  try {
    const { id } = req.params;
    let { status, eligibility, recommendedService, recommendedPackageId, internalNotes } = req.body;
    
    // If frontend sends an object (outcome), stringify it for DB storage
    if (typeof eligibility === 'object' && eligibility !== null) {
      eligibility = JSON.stringify(eligibility);
    }

    // 1-Hour Cancellation Rule Enforcement
    if (status === 'Cancelled') {
      const existingConsultation = await prisma.consultation.findUnique({
        where: { id }
      });
      if (!existingConsultation) {
        return res.status(404).json({ message: 'Consultation not found' });
      }

      if (existingConsultation.status === 'Cancelled') {
        // Idempotency: Already cancelled, just return success
        return res.json(existingConsultation);
      }

      const timeStr = existingConsultation.timeSlot && existingConsultation.timeSlot.includes(':') 
        ? existingConsultation.timeSlot 
        : '10:00';
      const meetingStartStr = `${existingConsultation.date}T${timeStr}:00.000Z`;
      const meetingStart = new Date(meetingStartStr);
      
      if (!isNaN(meetingStart.getTime())) {
        const timeDiffMs = meetingStart.getTime() - Date.now();
        const oneHourMs = 60 * 60 * 1000;
        
        if (timeDiffMs <= oneHourMs && timeDiffMs > -oneHourMs) { // Prevent cancellation if within 1 hour before or during
          return res.status(400).json({ 
            success: false, 
            message: 'Cancellation not allowed within 1 hour of the scheduled meeting time.' 
          });
        }
      }
    }
    
    const consultation = await prisma.consultation.update({
      where: { id },
      data: { status, eligibility, recommendedService, recommendedPackageId, internalNotes }
    });

    // Auto-update associated lead status if completed
    if (consultation.leadId && status === 'Completed') {
      let isEligible = false;
      let isNotEligible = false;

      let eligVal = eligibility || '';
      if (typeof eligibility === 'string' && eligibility.startsWith('{')) {
        try {
          const parsed = JSON.parse(eligibility);
          eligVal = parsed.eligibility || '';
        } catch (e) {}
      }

      if (typeof eligVal === 'string') {
        const lowerElig = eligVal.toLowerCase();
        if (lowerElig.includes('not eligible') || lowerElig === 'not_eligible') {
          isNotEligible = true;
        } else if (lowerElig.includes('eligible') || lowerElig === 'eligible') {
          isEligible = true;
        }
      }

      let newLeadStatus = 'Meeting Completed';
      if (isEligible) {
        newLeadStatus = 'Eligible';
      } else if (isNotEligible) {
        newLeadStatus = 'Not Eligible';
      }

      const updatedLead = await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { status: newLeadStatus }
      });
      console.log(`[Outcome Status Trigger] Lead ${consultation.leadId} status updated to: ${newLeadStatus}`);

        // If Eligible, auto-send appropriate WhatsApp message based on service type
        if (newLeadStatus === 'Eligible' && updatedLead.clientId) {
          const clientRecord = await prisma.client.findUnique({
            where: { id: updatedLead.clientId }
          });
          if (clientRecord && clientRecord.phone) {
            try {
              const { sendCustomWhatsApp } = require('../services/chatbotService');
              const checkoutLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login?redirect=packages`;
              const clientName = `${clientRecord.firstName} ${clientRecord.lastName}`;
              const serviceTypeLower = (updatedLead.serviceType || clientRecord.serviceType || '').toLowerCase();
              const isPropertyService = serviceTypeLower.includes('property') || serviceTypeLower.includes('investment');

              let msgToSend;
              if (isPropertyService) {
                // Property Investment — different follow-up message
                msgToSend = `Hello *${clientName}*,\n\nThank you for attending your Free Property Investment Consultation! 🏠🇪🇸\n\nBased on our discussion, our team will now prepare a curated list of properties that match your investment criteria:\n📍 *Preferred Area:* ${updatedLead.preferableArea || clientRecord.serviceType || 'Spain'}\n💰 *Budget Range:* ${updatedLead.budget || 'As discussed'}\n\nOur property investment specialist will contact you shortly with tailored property listings and next steps.\n\nFor any questions, you can also access your client portal here:\n🔗 ${checkoutLink}`;
              } else {
                // Spain Visa — standard package selection message
                msgToSend = `Hello *${clientName}*,\n\nThank you for attending your Free Spain Visa Eligibility Assessment. 🎉\n\nBased on our assessment, you are *ELIGIBLE* to proceed!\n\nPlease select your preferred Spanish residency service package to initiate the processing:\n\n*OPTION A: PROFESSIONAL CASE ASSESSMENT*\n• Price: €250\n• Non-refundable\n• If you proceed with either our Full Processing Package or Premium Package within 14 days, the €250 Professional Case Assessment fee will be deducted from your selected package price.\n\n*OPTION B: FULL PROCESSING PACKAGE – END-TO-END SERVICE*\n• Main Applicant: €3,500\n• Each Additional Applicant: €500\n• 50% refundable if the visa application is rejected, subject to the company’s terms and conditions.\n\n*OPTION C: ADMINISTRATIVE RELOCATION PACKAGE – POST-APPROVAL ASSISTANCE IN SPAIN*\n• Main Applicant: €1,750\n• Each Additional Applicant: €500\n• Non-refundable\n\n*OPTION D: PREMIUM PACKAGE – END-TO-END SERVICE + ADMINISTRATIVE RELOCATION PACKAGE*\n• Main Applicant: €4,750\n• Each Additional Applicant: €750\n• 50% refundable if the visa application is rejected, subject to the company’s terms and conditions.\n\nTo select your package and proceed with the payment, please click the secure link below:\n🔗 ${checkoutLink}`;
              }

              sendCustomWhatsApp(clientRecord.phone, msgToSend).catch(err => console.error('[BG-WA] Eligible notification failed:', err.message));
              console.log(`[Auto-WhatsApp] Sent ${isPropertyService ? 'property follow-up' : 'package options'} to client ${clientRecord.phone}`);
            } catch (err) {
              console.error('[Auto-WhatsApp] Failed to send WhatsApp message:', err.message);
            }
          }
        }

        // Schedule €250 Drip follow-ups (3 days & 7 days later) if remindersQueue is active
        if (remindersQueue && remindersQueue.add) {
          // Schedule Drip #2 (3 days)
          await remindersQueue.add('consultation-completed-drip', {
            leadId: updatedLead.id,
            clientId: updatedLead.clientId,
            email: updatedLead.email,
            phone: updatedLead.phone,
            firstName: updatedLead.firstName,
            lastName: updatedLead.lastName,
            dripIndex: 2
          }, {
            delay: 3 * 24 * 60 * 60 * 1000 // 3 days
          });

          // Schedule Drip #3 (7 days / 1 week)
          await remindersQueue.add('consultation-completed-drip', {
            leadId: updatedLead.id,
            clientId: updatedLead.clientId,
            email: updatedLead.email,
            phone: updatedLead.phone,
            firstName: updatedLead.firstName,
            lastName: updatedLead.lastName,
            dripIndex: 3
          }, {
            delay: 7 * 24 * 60 * 60 * 1000 // 7 days
          });
          console.log(`[Auto-Completed] Scheduled €250 assessment drips for lead ${updatedLead.id}`);
        }
    }

    // Trigger automated post-consultation Google Review WhatsApp messages (Immediate + 3d + 7d drips)
    if (status === 'Completed') {
      (async () => {
        try {
          let targetPhone = null;
          let targetName = null;
          let targetClientId = null;

          if (consultation.leadId) {
            const lead = await prisma.lead.findUnique({
              where: { id: consultation.leadId },
              select: { phone: true, firstName: true, lastName: true, clientId: true }
            });
            if (lead) {
              targetPhone = lead.phone;
              targetName = `${lead.firstName} ${lead.lastName}`.trim();
              targetClientId = lead.clientId;
            }
          }

          // 1st Message (Immediate)
          await sendGoogleReviewRequestWhatsApp({
            phone: targetPhone,
            clientName: targetName,
            clientId: targetClientId,
            leadId: consultation.leadId
          });

          // Schedule 2nd Message (3 Days Delay) & 3rd Message (7 Days Delay) in BullMQ Queue
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
            console.log(`[Google Review Drip] Scheduled 3-day and 7-day Google Review drips for lead ${consultation.leadId}`);
          }
        } catch (gReviewErr) {
          console.error('[Google Review Trigger] Error triggering review request:', gReviewErr.message);
        }
      })();
    }

    // Auto-update associated lead status if No Show
    if (consultation.leadId && (status === 'No Show' || status === 'No-Show' || status === 'NO_SHOW')) {
      const updatedLead = await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { status: 'No Show' }
      });

      // Blacklist the lead details
      try {
        await prisma.blacklistedClient.upsert({
          where: { email: updatedLead.email.toLowerCase() },
          update: { phone: updatedLead.phone || '' },
          create: {
            email: updatedLead.email.toLowerCase(),
            name: `${updatedLead.firstName} ${updatedLead.lastName}`,
            phone: updatedLead.phone || ''
          }
        });
        console.log(`[Blacklist] Blacklisted client on No Show status: ${updatedLead.email}`);
      } catch (dbErr) {
        console.error('[Blacklist] Failed to insert blacklist record:', dbErr.message);
      }

      // Send No Show WhatsApp and Email (fire-and-forget — non-blocking)
      try {
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const paymentService = require('../services/paymentService');
        const clientName = `${updatedLead.firstName} ${updatedLead.lastName}`;
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        let paymentLink = `${frontendUrl}/#/portal/documents/${updatedLead.clientId || ''}`;

        if (updatedLead.clientId) {
          try {
            const noShowResult = await paymentService.createNoShowAssessmentPayment(updatedLead.clientId, consultation.id);
            if (noShowResult && noShowResult.url) {
              paymentLink = noShowResult.url;
            } else if (noShowResult && noShowResult.payment) {
              paymentLink = `${frontendUrl}/#/portal/login?redirect=no-show-payment&paymentId=${noShowResult.payment.id}`;
            }
          } catch (stripeErr) {
            console.error('[No Show] Failed to create No Show Assessment Payment, falling back to portal:', stripeErr.message);
          }
        }
        
        const noShowMsg = `Hello *${clientName}*,\n\nYour Free Eligibility Assessment has been automatically cancelled because you did not join the meeting within 10 minutes of the scheduled start time.\n\nDue to our no-show policy, we are unable to reschedule another Free Eligibility Assessment. You are welcome to review our services, packages, requirements, and application process by visiting the link below:\n\nServices & Packages: https://aaabusinessconsultancy.com/services-and-packages/\n\nIf you decide to proceed, we offer professional case assessment which is only *€250* (plus 5% VAT) including dedicated One-to-One Case Review. You can securely checkout here:\n🔗 ${paymentLink}`;
        
        sendCustomWhatsApp(updatedLead.phone, noShowMsg).catch(err => console.error('[BG-WA] No Show WA failed:', err.message));
        
        sendEmail({
          to: updatedLead.email,
          subject: 'Your Spain Visa Consultation Cancellation - AAA Business Consultancy',
          html: `
            <h3>Consultation Cancelled - No Show</h3>
            <p>Dear ${updatedLead.firstName},</p>
            <p>Your Free Eligibility Assessment has been automatically cancelled because you did not join the meeting within 10 minutes of the scheduled start time.</p>
            <p>Due to our no-show policy, we are unable to reschedule another Free Eligibility Assessment. You are welcome to review our services, packages, requirements, and application process by visiting <a href="https://aaabusinessconsultancy.com/services-and-packages/">Services & Packages</a>.</p>
            <p>If you decide to proceed, we offer professional case assessment which is only <strong>€250</strong> (plus 5% VAT) including a dedicated One-to-One Case Review. You can securely checkout using this link: <a href="${paymentLink}">${paymentLink}</a></p>
            <p>Thank you for your understanding.</p>
          `
        }).catch(err => console.error('[BG-Email] No Show email failed:', err.message));
        console.log(`[Auto-NoShow] Dispatched no-show notifications to ${updatedLead.email}`);
      } catch (err) {
        console.error('[Auto-NoShow] Failed to dispatch no-show notifications:', err.message);
      }
    }

    // Auto-update associated lead status if Cancelled
    if (consultation.leadId && status === 'Cancelled') {
      const updatedLead = await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { status: 'Meeting Cancelled' }
      });

      // Send Rebook link (fire-and-forget — non-blocking)
      try {
        const { notifyClient } = require('../services/notificationService');
        if (updatedLead.clientId) {
          notifyClient({
            event: 'MEETING_CANCELLED',
            clientId: updatedLead.clientId,
            consultationId: consultation.id
          }).catch(err => console.error('[Auto-Cancel] notifyClient failed:', err.message));
        } else {
          console.warn(`[Auto-Cancel] No clientId on lead ${updatedLead.id}, skipping central notification`);
        }

        // Schedule 24-hour delayed rebooking reminder if remindersQueue is active
        if (remindersQueue && remindersQueue.add) {
          await remindersQueue.add('cancelled-rebook-reminder', {
            leadId: updatedLead.id,
            email: updatedLead.email,
            phone: updatedLead.phone,
            firstName: updatedLead.firstName,
            lastName: updatedLead.lastName
          }, {
            delay: 24 * 60 * 60 * 1000 // 24 hours
          });
          console.log(`[Auto-Cancel] Scheduled 24-hour rebook reminder for lead ${updatedLead.id}`);
        }
      } catch (err) {
        console.error('[Auto-Cancel] Failed to dispatch cancellation notifications:', err.message);
      }
    }

    res.json(consultation);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating consultation outcome' });
  }
};

const respondToConsultation = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, declineReason } = req.body; // action: 'accept' | 'decline'

    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action. Must be accept or decline.' });
    }

    const isDecline = action === 'decline';
    const newStatus = isDecline ? 'Declined' : 'Scheduled';

    const existingConsultation = await prisma.consultation.findUnique({
      where: { id },
      include: { lead: true }
    });
    if (!existingConsultation) {
      return res.status(404).json({ message: 'Consultation not found.' });
    }

    let meetingLink = existingConsultation.meetingLink;
    if (action === 'accept' && !meetingLink) {
      // Always generate a fresh Zoom meeting link when agent accepts
      if (zoomService.isConfigured) {
        try {
          let startTimeISO = new Date().toISOString();
          if (existingConsultation.date) {
            const timeStr = existingConsultation.timeSlot && existingConsultation.timeSlot.includes(':') 
              ? existingConsultation.timeSlot 
              : '10:00';
            const dateObj = new Date(`${existingConsultation.date}T${timeStr}`);
            if (!isNaN(dateObj.getTime())) {
              startTimeISO = dateObj.toISOString();
            }
          }
          const zoomMeeting = await zoomService.createZoomMeeting({
            topic: `Eligibility Assessment for Lead ${existingConsultation.leadId || ''}`,
            startTime: startTimeISO,
            durationMinutes: existingConsultation.durationMinutes || 30
          });
          if (zoomMeeting) {
            meetingLink = zoomMeeting.joinUrl;
          }
        } catch (zoomErr) {
          console.error('Failed to create Zoom meeting on accept:', zoomErr.message);
        }
      }
      // Fallback: generate a placeholder link if Zoom not configured or failed
      if (!meetingLink) {
        meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
      }
    }

    const consultation = await prisma.consultation.update({
      where: { id },
      data: {
        status: newStatus,
        meetingLink,
        consultantId: isDecline ? null : undefined, // Remove from agent's calendar
        internalNotes: isDecline && declineReason
          ? `[Agent Declined]: ${declineReason}`
          : undefined
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true } },
        consultant: { select: { fullName: true } }
      }
    });

    if (isDecline && consultation.lead?.id) {
      // Unassign the lead so it goes back to Admin pool
      await prisma.lead.update({
        where: { id: consultation.lead.id },
        data: { 
          assignedToId: null, 
          status: 'Agent Declined',
          notes: declineReason ? `Meeting declined by agent. Reason: ${declineReason}` : 'Meeting declined by agent.'
        }
      });
    }

    if (action === 'accept') {
      if (consultation.lead?.id) {
        await prisma.lead.update({
          where: { id: consultation.lead.id },
          data: { status: 'Meeting Scheduled' }
        }).catch(err => console.error('[respondToConsultation] Lead status update error:', err.message));
      }
      sendConsultationNotifications(consultation).catch(err => console.error('[NOTIFICATIONS] Async error:', err));
    }

    res.json({
      success: true,
      status: newStatus,
      message: action === 'accept'
        ? 'Meeting accepted successfully!'
        : 'Meeting declined. Lead has been sent back to Admin for reassignment.',
      consultation
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error responding to consultation', error: error.message });
  }
};

// Auto-create a consultation with "Pending Acceptance" when admin assigns an agent
const createConsultationForLead = async (req, res) => {
  try {
    const { leadId, consultantId, meetingDate, meetingTime, durationMinutes } = req.body;

    // Check if a Pending Acceptance consultation already exists for this lead
    const existing = await prisma.consultation.findFirst({
      where: { leadId, status: 'Pending Acceptance' }
    });
    if (existing) {
      // Just reassign the existing one
      const updated = await prisma.consultation.update({
        where: { id: existing.id },
        data: { consultantId, status: 'Pending Acceptance' }
      });
      return res.json({ success: true, consultation: updated, reassigned: true });
    }

    let meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
    
    if (zoomService.isConfigured) {
      try {
        let startTimeISO = new Date().toISOString();
        if (meetingDate) {
          const timeStr = meetingTime && meetingTime.includes(':') ? meetingTime : '10:00';
          const dateObj = new Date(`${meetingDate}T${timeStr}`);
          if (!isNaN(dateObj.getTime())) {
            startTimeISO = dateObj.toISOString();
          }
        }
        
        const zoomMeeting = await zoomService.createZoomMeeting({
          topic: `Eligibility Assessment for Lead ${leadId || ''}`,
          startTime: startTimeISO,
          durationMinutes: durationMinutes || 30
        });
        
        if (zoomMeeting) {
          meetingLink = zoomMeeting.joinUrl;
        }
      } catch (zoomErr) {
        console.error('Failed to create Zoom meeting, falling back to mock link:', zoomErr.message);
      }
    }

    const consultation = await prisma.consultation.create({
      data: {
        leadId,
        consultantId,
        date: meetingDate || '',
        timeSlot: meetingTime || 'TBD',
        durationMinutes: durationMinutes || 30,
        status: 'Pending Acceptance',
        meetingLink
      }
    });

    return res.status(201).json({ success: true, consultation });
  } catch (error) {
    return res.status(500).json({ message: 'Server error creating consultation for lead', error: error.message });
  }
};

const reassignConsultant = async (req, res) => {
  try {
    const { id } = req.params;
    const { consultantId, reason, allowConflict } = req.body;

    if (!consultantId) {
      return res.status(400).json({ message: 'Target consultant ID is required' });
    }

    // 1. Fetch current consultation record
    const consultation = await prisma.consultation.findUnique({
      where: { id },
      include: {
        lead: true,
        consultant: { select: { id: true, fullName: true } }
      }
    });

    if (!consultation) {
      return res.status(404).json({ message: 'Consultation not found' });
    }

    // 2. Fetch new consultant details
    const newConsultant = await prisma.user.findUnique({
      where: { id: consultantId },
      select: { id: true, fullName: true, role: true }
    });

    if (!newConsultant) {
      return res.status(404).json({ message: 'New consultant not found' });
    }

    // 3. Conflict Check
    if (!allowConflict && consultation.date && consultation.timeSlot) {
      const conflict = await prisma.consultation.findFirst({
        where: {
          id: { not: id },
          consultantId: consultantId,
          date: consultation.date,
          timeSlot: consultation.timeSlot,
          status: { notIn: ['Cancelled', 'No Show'] }
        }
      });

      if (conflict) {
        return res.status(409).json({
          success: false,
          conflict: true,
          message: `Consultant ${newConsultant.fullName} already has a session booked at ${consultation.date} ${consultation.timeSlot}.`,
          conflictingConsultation: conflict
        });
      }
    }

    const oldConsultantName = consultation.consultant?.fullName || 'Unassigned';
    const oldConsultantId = consultation.consultant?.id || null;
    const adminUser = req.user;

    // 4. Update consultation and lead
    const updatedConsultation = await prisma.consultation.update({
      where: { id },
      data: {
        consultantId,
        assignedAt: new Date(),
        internalNotes: consultation.internalNotes
          ? `${consultation.internalNotes}\n[Reassigned by ${adminUser?.fullName || 'Admin'} from ${oldConsultantName} to ${newConsultant.fullName}. Reason: ${reason || 'N/A'}]`
          : `[Reassigned by ${adminUser?.fullName || 'Admin'} from ${oldConsultantName} to ${newConsultant.fullName}. Reason: ${reason || 'N/A'}]`
      },
      include: {
        lead: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        consultant: { select: { id: true, fullName: true, role: true } }
      }
    });

    if (consultation.leadId) {
      await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { assignedToId: consultantId, assignedAt: new Date() }
      });
    }

    // 5. Create Audit Log entry in CommunicationLog
    if (consultation.lead?.phone) {
      await prisma.communicationLog.create({
        data: {
          clientId: null,
          phone: consultation.lead.phone,
          name: adminUser?.fullName || 'Admin',
          respondedByUserId: adminUser?.id || null,
          channel: 'WHATSAPP',
          direction: 'SYSTEM',
          content: `[REASSIGNMENT AUDIT LOG] Consultation (${consultation.date} ${consultation.timeSlot}) reassigned from "${oldConsultantName}" (${oldConsultantId || 'none'}) to "${newConsultant.fullName}" (${newConsultant.id}) by ${adminUser?.fullName || 'Admin'}. Reason: ${reason || 'Manual override'}`,
          deliveryStatus: 'LOGGED'
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: `Consultation successfully reassigned to ${newConsultant.fullName}`,
      consultation: updatedConsultation,
      auditLog: {
        oldConsultant: oldConsultantName,
        newConsultant: newConsultant.fullName,
        reassignedBy: adminUser?.fullName || 'Admin',
        reason: reason || 'Manual override',
        timestamp: new Date()
      }
    });
  } catch (error) {
    console.error('Error reassigning consultation:', error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
};

async function sendConsultationNotifications(consultation) {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: consultation.leadId }
    });

    if (!lead) {
      console.warn(`[NOTIFICATIONS] Lead not found for consultation ${consultation.id}. Skipping.`);
      return;
    }

    const email = lead.email;
    const phone = lead.phone;
    const name = `${lead.firstName} ${lead.lastName}`;
    const date = consultation.date;
    const time = consultation.timeSlot;
    const link = consultation.meetingLink || 'https://zoom.us';

    console.log(`[NOTIFICATIONS] Dispatching scheduling notifications for Lead: ${name} (${phone} / ${email})`);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;
    const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultation.id}`;
    const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

    // 1. Send WhatsApp Message
    try {
      const { sendCustomWhatsApp } = require('../services/chatbotService');
      const waMsg = `✈️ *Spain Visa Consultation Confirmed!*

Dear *${name}*,

Your Spain Visa Consultation with *AAA Business Consultancy* has been scheduled successfully! 🎉

📅 *Date:* ${date}
⏰ *Time:* ${time} (UTC)
🔗 *Meeting Join Link:* ${link}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* ${rescheduleUrl}
• ❌ *Cancel Booking:* ${cancelUrl}
• 📦 *View Visa Packages:* ${packagesUrl}

_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`;

      await sendCustomWhatsApp(phone, waMsg);
    } catch (waErr) {
      console.error('[NOTIFICATIONS] Failed to send WhatsApp confirmation:', waErr.message);
    }

    // 2. Send Branded Email
    try {
      const { sendAppointmentConfirmationEmail } = require('../services/emailService');
      await sendAppointmentConfirmationEmail({
        to: email,
        firstName: lead.firstName,
        date,
        timeSlot: time,
        meetingLink: link,
        consultationId: consultation.id
      });
    } catch (emailErr) {
      console.error('[NOTIFICATIONS] Failed to send Email confirmation:', emailErr.message);
    }

    // 3. Schedule 3 Reminders (24h, 1h, 10m before)
    if (remindersQueue && remindersQueue.add) {
      const meetingStart = new Date(`${date}T${time.includes(':') ? time : '10:00'}`);
      if (!isNaN(meetingStart.getTime())) {
        const now = Date.now();

        const scheduleReminder = async (label, timeBeforeMs, subject, textLabel) => {
          const reminderTime = meetingStart.getTime() - timeBeforeMs;
          const delay = reminderTime - now;
          if (delay > 0) {
            await remindersQueue.add('send-reminder', {
              toEmail: email,
              toPhone: phone,
              subject: subject,
              emailHtml: `<h3>Meeting Reminder</h3><p>Dear ${lead.firstName}, your Spain Visa Consultation is in ${textLabel}.</p><p>Zoom Join Link: <a href="${link}">${link}</a></p>`,
              whatsappTemplate: 'consultation_scheduled_confirmation',
              whatsappComponents: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: lead.firstName },
                    { type: 'text', text: date },
                    { type: 'text', text: time },
                    { type: 'text', text: link }
                  ]
                }
              ]
            }, {
              jobId: `reminder-${label}-${consultation.id}`,
              delay: delay
            });
            console.log(`[NOTIFICATIONS] Enqueued ${label} reminder with delay: ${Math.round(delay / 60000)} minutes`);
          }
        };

        // 24 Hours Reminder (24 * 60 * 60 * 1000)
        await scheduleReminder('24h', 24 * 60 * 60 * 1000, 'Reminder: Spain Visa Consultation in 24 Hours', '24 Hours');

        // 1 Hour Reminder (1 * 60 * 60 * 1000)
        await scheduleReminder('1h', 1 * 60 * 60 * 1000, 'Reminder: Spain Visa Consultation in 1 Hour', '1 Hour');

        // 10 Minutes Reminder (10 * 60 * 1000)
        await scheduleReminder('10m', 10 * 60 * 1000, 'Urgent Reminder: Spain Visa Consultation in 10 Minutes', '10 Minutes');
      }
    }
  } catch (err) {
    console.error('[NOTIFICATIONS] Error in sendConsultationNotifications:', err);
  }
}

/**
 * Public Reschedule Consultation
 */
async function publicRescheduleConsultation(req, res) {
  try {
    const { consultationId, date, timeSlot } = req.body;

    if (!consultationId || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: 'Consultation ID, date, and timeSlot are required.' });
    }

    // Same-Day Booking Restriction
    if (date) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (date <= todayStr) {
        return res.status(400).json({
          success: false,
          message: 'Booking date must be at least the next calendar day.'
        });
      }
    }

    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { lead: true }
    });

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    const updatedConsultation = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        date,
        timeSlot,
        status: 'Scheduled'
      }
    });

    if (consultation.leadId) {
      await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { status: 'Meeting Scheduled' }
      }).catch(e => console.warn('Could not update lead status on reschedule:', e.message));
    }

    const lead = consultation.lead;
    const clientName = lead ? `${lead.firstName} ${lead.lastName}` : 'Client';
    const email = lead ? lead.email : null;
    const phone = lead ? lead.phone : null;
    const link = updatedConsultation.meetingLink || 'https://zoom.us';

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultationId}`;
    const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultationId}`;
    const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

    // Send notifications
    if (phone) {
      try {
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const waMsg = `✈️ *Spain Visa Consultation Rescheduled!*

Dear *${clientName}*,

Your Spain Visa Eligibility Assessment has been successfully rescheduled.

📅 *New Date:* ${date}
⏰ *New Time:* ${timeSlot} (UTC)
🔗 *Zoom Join Link:* ${link}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* ${rescheduleUrl}
• ❌ *Cancel Booking:* ${cancelUrl}
• 📦 *View Visa Packages:* ${packagesUrl}

_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`;
        await sendCustomWhatsApp(phone, waMsg);
      } catch (waErr) {
        console.error('Reschedule WhatsApp error:', waErr.message);
      }
    }

    if (email) {
      try {
        const { sendAppointmentConfirmationEmail } = require('../services/emailService');
        await sendAppointmentConfirmationEmail({
          to: email,
          firstName: lead ? lead.firstName : 'Client',
          date,
          timeSlot,
          meetingLink: link,
          consultationId
        });
      } catch (emailErr) {
        console.error('Reschedule Email error:', emailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Consultation rescheduled successfully',
      data: { consultation: updatedConsultation }
    });
  } catch (error) {
    console.error('Error in publicRescheduleConsultation:', error);
    return res.status(500).json({ success: false, message: 'Failed to reschedule consultation.' });
  }
}

/**
 * Public Cancel Consultation
 */
async function publicCancelConsultation(req, res) {
  try {
    const { consultationId } = req.body;

    if (!consultationId) {
      return res.status(400).json({ success: false, message: 'Consultation ID is required.' });
    }

    const consultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: { lead: true }
    });

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    // Meeting Cancellation Restriction (within 1 hour)
    if (consultation.date && consultation.timeSlot) {
      try {
        const timePart = consultation.timeSlot.split('-')[0].trim();
        if (timePart.includes(':')) {
          const [hours, minutes] = timePart.split(':').map(Number);
          const [year, month, day] = consultation.date.split('-').map(Number);
          const meetingTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
          
          const diffMs = meetingTime.getTime() - Date.now();
          const diffHours = diffMs / (1000 * 60 * 60);
          
          if (diffHours <= 1) {
            return res.status(400).json({
              success: false,
              message: 'Cancellation is not allowed within 1 hour of the scheduled meeting time.'
            });
          }
        }
      } catch (err) {
        console.error('Error validating cancellation window:', err);
      }
    }

    const updatedConsultation = await prisma.consultation.update({
      where: { id: consultationId },
      data: { status: 'Cancelled' }
    });

    if (consultation.leadId) {
      await prisma.lead.update({
        where: { id: consultation.leadId },
        data: { status: 'Meeting Cancelled' }
      }).catch(e => console.warn('Could not update lead status:', e.message));
    }

    const lead = consultation.lead;
    const clientName = lead ? `${lead.firstName} ${lead.lastName}` : 'Client';
    const email = lead ? lead.email : null;
    const phone = lead ? lead.phone : null;

    if (phone) {
      try {
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const waMsg = `❌ *Spain Visa Consultation Cancelled*

Dear *${clientName}*,

Your Spain Visa Eligibility Assessment scheduled for ${consultation.date} at ${consultation.timeSlot} (UTC) has been cancelled as requested.

If you ever wish to re-book, feel free to visit our booking page anytime:
${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/lead-form`;

        await sendCustomWhatsApp(phone, waMsg);
      } catch (waErr) {
        console.error('Cancel WhatsApp error:', waErr.message);
      }
    }

    if (email) {
      try {
        const { sendEmail } = require('../services/emailService');
        await sendEmail({
          to: email,
          subject: 'Appointment Cancelled: Spain Visa Eligibility Assessment',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
              <h3>Appointment Cancellation Confirmed</h3>
              <p>Dear ${lead ? lead.firstName : 'Client'},</p>
              <p>Your Spain Visa Eligibility Assessment scheduled for <b>${consultation.date}</b> at <b>${consultation.timeSlot} (UTC)</b> has been cancelled.</p>
              <p>You can book a new session anytime at <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/lead-form">AAA Business Consultancy</a>.</p>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('Cancel Email error:', emailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Consultation cancelled successfully',
      data: { consultation: updatedConsultation }
    });
  } catch (error) {
    console.error('Error in publicCancelConsultation:', error);
    return res.status(500).json({ success: false, message: 'Failed to cancel consultation.' });
  }
}

async function getPublicConsultationDetails(req, res) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: 'Consultation ID is required.' });
    }

    const consultation = await prisma.consultation.findUnique({
      where: { id },
      include: { lead: true }
    });

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Consultation not found.' });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: consultation.id,
        date: consultation.date,
        timeSlot: consultation.timeSlot,
        status: consultation.status,
        clientName: consultation.lead ? `${consultation.lead.firstName} ${consultation.lead.lastName}` : 'Client'
      }
    });
  } catch (error) {
    console.error('Error in getPublicConsultationDetails:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve consultation details.' });
  }
}

module.exports = {
  getConsultations,
  createConsultation,
  updateOutcome,
  respondToConsultation,
  createConsultationForLead,
  reassignConsultant,
  publicRescheduleConsultation,
  publicCancelConsultation,
  getPublicConsultationDetails
};

