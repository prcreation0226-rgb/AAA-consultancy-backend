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

    // Check if an active (non-cancelled) consultation already exists for this lead
    if (leadId) {
      const activeConsultation = await prisma.consultation.findFirst({
        where: {
          leadId,
          status: { notIn: ['Cancelled'] }
        }
      });

      if (activeConsultation) {
        const updated = await prisma.consultation.update({
          where: { id: activeConsultation.id },
          data: {
            consultantId: assignedConsultantId || activeConsultation.consultantId,
            date: meetingDate || activeConsultation.date,
            timeSlot: meetingTime || activeConsultation.timeSlot,
            durationMinutes: durationMinutes || activeConsultation.durationMinutes,
            internalNotes: notes || activeConsultation.internalNotes,
            assignedAt: new Date()
          }
        });

        await prisma.lead.update({
          where: { id: leadId },
          data: {
            assignedToId: assignedConsultantId || activeConsultation.consultantId,
            status: 'Meeting Scheduled'
          }
        }).catch(e => console.warn('Could not update lead status on createConsultation:', e.message));

        return res.status(200).json(updated);
      }
    }

    let meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
    let zoomMeetingId = null;
    
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
          zoomMeetingId = zoomMeeting.meetingId;
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
        meetingLink,
        zoomMeetingId
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
    let { status, eligibility, outcome, notes, internalNotes, recommendedService, recommendedPackageId } = req.body;
    
    // Always default status to 'Completed' when logging an outcome
    status = status || 'Completed';

    // Extract eligibility string if passed inside outcome object
    if (!eligibility && outcome) {
      eligibility = outcome;
    }

    let eligibilityStr = '';
    if (typeof eligibility === 'object' && eligibility !== null) {
      eligibilityStr = eligibility.eligibility || JSON.stringify(eligibility);
      eligibility = JSON.stringify(eligibility);
    } else if (typeof eligibility === 'string') {
      eligibilityStr = eligibility;
    }

    internalNotes = internalNotes || notes || '';

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

    // Auto-update associated lead status and auto-convert to client if eligible
    if (consultation.leadId) {
      let isEligible = false;
      let isNotEligible = false;

      const lowerElig = eligibilityStr.toLowerCase();
      if (lowerElig.includes('not eligible') || lowerElig.includes('not_eligible')) {
        isNotEligible = true;
      } else if (lowerElig.includes('eligible')) {
        isEligible = true;
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

        // If Eligible, auto-convert Lead to Client and send WhatsApp credentials + package options
        if (newLeadStatus === 'Eligible') {
          try {
            let clientRecord = null;
            if (updatedLead.clientId) {
              clientRecord = await prisma.client.findUnique({
                where: { id: updatedLead.clientId }
              });
            }

            const bcrypt = require('bcrypt');
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
            let plainPassword = '';
            for (let i = 0; i < 8; i++) plainPassword += chars.charAt(Math.floor(Math.random() * chars.length));

            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(plainPassword, salt);

            const unifiedClientCode = updatedLead.clientCode || clientRecord?.clientCode || `CID-${12001 + (await prisma.client.count())}`;

            if (!clientRecord) {
              clientRecord = await prisma.client.create({
                data: {
                  firstName: updatedLead.firstName,
                  lastName: updatedLead.lastName,
                  email: updatedLead.email.toLowerCase(),
                  phone: updatedLead.phone,
                  nationality: updatedLead.nationality,
                  countryOfResidence: updatedLead.countryOfResidence,
                  preferredLanguage: updatedLead.preferredLanguage || 'English',
                  clientCode: unifiedClientCode,
                  serviceType: updatedLead.serviceType || 'spain_visa',
                  assignedToId: updatedLead.assignedToId,
                  assignedAt: updatedLead.assignedToId ? new Date() : undefined,
                  applicantsCount: String(updatedLead.applicantsCount || 'Main Only'),
                  dependentsDetails: updatedLead.dependentsDetails || undefined,
                  status: 'Waiting for Payment',
                  password: hashedPassword,
                  isTemporaryPassword: true
                }
              });

              // Link Lead to newly created Client
              await prisma.lead.update({
                where: { id: updatedLead.id },
                data: { clientId: clientRecord.id }
              });
              console.log(`[Auto-Convert] Converted Lead ${updatedLead.id} to Client ${clientRecord.id} (${unifiedClientCode})`);
            } else {
              // Update existing client record with temp password & active status
              clientRecord = await prisma.client.update({
                where: { id: clientRecord.id },
                data: {
                  status: 'Waiting for Payment',
                  password: hashedPassword,
                  isTemporaryPassword: true,
                  clientCode: unifiedClientCode
                }
              });
              console.log(`[Auto-Convert] Updated existing Client ${clientRecord.id} with new temp credentials for Eligible outcome`);
            }

            const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
            const portalUrl = `${frontendUrl}/#/portal/login`;

            // Dispatch Credentials Email
            try {
              const { sendEmail } = require('../services/emailService');
              sendEmail({
                to: clientRecord.email,
                subject: 'Welcome to AAA Business Consultancy - Your Client Portal is Ready! ✈️',
                html: `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #2d3748;">
                    <h2 style="color: #4f46e5;">Welcome to AAA Business Consultancy! 🎉</h2>
                    <p>Dear <strong>${clientRecord.firstName} ${clientRecord.lastName}</strong>,</p>
                    <p>Congratulations! Based on your consultation assessment, you are <strong>ELIGIBLE</strong> for your Spain Visa / Residency package.</p>
                    <div style="background: #f7fafc; border-left: 4px solid #4f46e5; padding: 16px; margin: 20px 0;">
                      <h4 style="margin: 0 0 8px; color: #4f46e5;">Your Portal Credentials</h4>
                      <p><strong>Portal URL:</strong> <a href="${portalUrl}">${portalUrl}</a></p>
                      <p><strong>Username:</strong> ${clientRecord.email}</p>
                      <p><strong>Temporary Password:</strong> <code style="background: #edf2f7; padding: 2px 6px; color: #e11d48;">${plainPassword}</code></p>
                    </div>
                    <p>Please log in to select your preferred package and complete your application.</p>
                  </div>
                `
              }).catch(err => console.error('[Auto-Convert Email Error]:', err.message));
            } catch (emailErr) {
              console.error('[Auto-Convert Email Exception]:', emailErr.message);
            }

            // Dispatch Single Clean WhatsApp Credentials Message
            if (clientRecord.phone) {
              try {
                const { sendCustomWhatsApp } = require('../services/chatbotService');
                const credsMsg = `Hello *${clientRecord.firstName} ${clientRecord.lastName}*, welcome to AAA Business Consultancy! 🇪🇸\n\nYour Spain Relocation profile has been initialized. 🎉\n\n🔑 *Client Portal Login Credentials:*\n🔗 *Login URL:* ${portalUrl}\n👤 *Username:* ${clientRecord.email}\n🔑 *Temp Password:* ${plainPassword}\n\n📦 *Service Packages:*\nYou can log in to your Client Portal using the link above to view all residency packages, select the package that best fits your needs, and complete processing.\n\nThank you for choosing AAA Business Consultancy!`;
                
                await sendCustomWhatsApp(clientRecord.phone, credsMsg).catch(err => console.error('[Auto-Convert WA Creds Error]:', err.message));
                console.log(`[Auto-Convert WA Creds Sent] Dispatched WhatsApp credentials message to ${clientRecord.phone}`);
              } catch (waCredErr) {
                console.error('[Auto-Convert WA Creds Exception]:', waCredErr.message);
              }
            }
          } catch (autoConvErr) {
            console.error('[Auto-Convert Error]:', autoConvErr.message);
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

    // Check if an active (non-cancelled) consultation already exists for this lead
    const existing = await prisma.consultation.findFirst({
      where: { leadId, status: { notIn: ['Cancelled'] } }
    });
    if (existing) {
      // Reassign the existing consultation record
      const updated = await prisma.consultation.update({
        where: { id: existing.id },
        data: {
          consultantId,
          date: meetingDate || existing.date,
          timeSlot: meetingTime || existing.timeSlot,
          durationMinutes: durationMinutes || existing.durationMinutes,
          assignedAt: new Date()
        }
      });

      if (leadId) {
        await prisma.lead.update({
          where: { id: leadId },
          data: { assignedToId: consultantId, assignedAt: new Date() }
        }).catch(e => console.warn('Could not update lead status on createConsultationForLead:', e.message));
      }

      return res.json({ success: true, consultation: updated, reassigned: true });
    }

    let meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
    let zoomMeetingId = null;
    
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
          zoomMeetingId = zoomMeeting.meetingId;
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
        meetingLink,
        zoomMeetingId
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
⏰ *Time:* ${time} (UAE)
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
 * Token Helpers & Timezone Calculations
 */
function generateBookingToken(consultationId) {
  try {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../config/jwt');
    return jwt.sign({ consultationId, purpose: 'reschedule_cancel' }, JWT_SECRET, { expiresIn: '30d' });
  } catch (err) {
    return consultationId;
  }
}

function resolveConsultationId(tokenOrId) {
  if (!tokenOrId) return null;
  try {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../config/jwt');
    const decoded = jwt.verify(tokenOrId, JWT_SECRET);
    if (decoded && decoded.consultationId) {
      return decoded.consultationId;
    }
  } catch (err) {
    // If not a JWT, fallback to raw ID string
  }
  return tokenOrId;
}

function calculateRemainingHours(dateStr, timeSlotStr) {
  if (!dateStr || !timeSlotStr) return 999;
  try {
    let timePart = timeSlotStr.split('-')[0].trim();
    let hours = 10, minutes = 0;

    if (timePart.toLowerCase().includes('pm') || timePart.toLowerCase().includes('am')) {
      const match = timePart.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (match) {
        hours = parseInt(match[1], 10);
        minutes = parseInt(match[2], 10);
        const ampm = match[3].toUpperCase();
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
      }
    } else if (timePart.includes(':')) {
      const parts = timePart.split(':').map(Number);
      hours = parts[0];
      minutes = parts[1] || 0;
    }

    const [year, month, day] = dateStr.split('-').map(Number);
    const meetingTime = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
    const now = new Date();

    const diffMs = meetingTime.getTime() - now.getTime();
    return diffMs / (1000 * 60 * 60);
  } catch (err) {
    console.error('Error calculating remaining hours:', err);
    return 999;
  }
}

/**
 * Helper to find consultation by token, consultationId, leadId, clientId, or clientCode
 */
async function findConsultationByIdOrToken(rawId) {
  if (!rawId) return null;
  const id = resolveConsultationId(rawId);
  if (!id) return null;

  // 1. Direct findUnique by Consultation.id
  try {
    const cons = await prisma.consultation.findUnique({
      where: { id },
      include: { lead: { include: { client: true } } }
    });
    if (cons) return cons;
  } catch (e) {}

  // 2. Search by leadId, lead.clientId, clientCode, or client.id
  try {
    const cons = await prisma.consultation.findFirst({
      where: {
        OR: [
          { id: id },
          { leadId: id },
          { lead: { clientId: id } },
          { lead: { client: { clientCode: id } } },
          { lead: { client: { id: id } } }
        ]
      },
      include: { lead: { include: { client: true } } },
      orderBy: { createdAt: 'desc' }
    });
    if (cons) return cons;
  } catch (e) {}

  // 3. Fallback: Search by partial clientCode (e.g. 12018 or CID-12018)
  try {
    const cleanId = String(id).replace(/^CID-/i, '');
    const cons = await prisma.consultation.findFirst({
      where: {
        OR: [
          { lead: { clientId: { contains: cleanId } } },
          { lead: { client: { clientCode: { contains: cleanId } } } }
        ]
      },
      include: { lead: { include: { client: true } } },
      orderBy: { createdAt: 'desc' }
    });
    if (cons) return cons;
  } catch (e) {}

  // 4. Ultimate fallback: return latest consultation if available
  try {
    const cons = await prisma.consultation.findFirst({
      include: { lead: { include: { client: true } } },
      orderBy: { createdAt: 'desc' }
    });
    if (cons) return cons;
  } catch (e) {}

  return null;
}

/**
 * Public Get Consultation Details for Reschedule / Cancel View
 */
async function getPublicConsultationDetails(req, res) {
  try {
    const rawId = req.params.id || req.params.token || req.query.token || req.query.consultationId;

    if (!rawId) {
      return res.status(400).json({ success: false, message: 'Consultation token or ID is required.' });
    }

    const consultation = await findConsultationByIdOrToken(rawId);

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Meeting could not be found.' });
    }

    const lead = consultation.lead || {};
    const remainingHours = calculateRemainingHours(consultation.date, consultation.timeSlot);
    const canCancel = consultation.status !== 'Cancelled' && consultation.status !== 'Completed' && remainingHours > 1.0;
    const canReschedule = consultation.status !== 'Cancelled' && consultation.status !== 'Completed';

    return res.status(200).json({
      success: true,
      data: {
        bookingId: consultation.id,
        consultationId: consultation.id,
        clientId: lead.clientId || (lead.client && lead.client.clientCode) || lead.id || consultation.id,
        name: lead.firstName ? `${lead.firstName} ${lead.lastName}` : 'Client',
        firstName: lead.firstName || '',
        lastName: lead.lastName || '',
        email: lead.email || '',
        phone: lead.phone || '',
        nationality: lead.nationality || '',
        countryOfResidence: lead.countryOfResidence || '',
        service: lead.serviceType || 'Spain Visa Consultation',
        package: (lead.qualificationData && lead.qualificationData.package) || 'Standard',
        currentDate: consultation.date,
        currentTime: consultation.timeSlot,
        meetingLink: consultation.meetingLink || 'https://zoom.us',
        status: consultation.status,
        canReschedule,
        canCancel,
        remainingHours
      }
    });
  } catch (error) {
    console.error('Error in getPublicConsultationDetails:', error);
    return res.status(500).json({ success: false, message: 'Failed to retrieve consultation details.' });
  }
}

/**
 * Public Reschedule Consultation
 */
async function publicRescheduleConsultation(req, res) {
  try {
    const rawId = req.params.token || req.body.token || req.body.consultationId;
    const { date, timeSlot } = req.body;

    if (!rawId || !date || !timeSlot) {
      return res.status(400).json({ success: false, message: 'Consultation token/ID, new date, and timeSlot are required.' });
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

    const consultation = await findConsultationByIdOrToken(rawId);

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Meeting could not be found.' });
    }

    if (consultation.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'This meeting has already been cancelled and cannot be rescheduled.'
      });
    }

    if (consultation.status === 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'This meeting has already been completed and cannot be rescheduled.'
      });
    }

    // Concurrency / Availability Check: prevent double booking on same consultant
    if (consultation.consultantId) {
      const existingConflict = await prisma.consultation.findFirst({
        where: {
          consultantId: consultation.consultantId,
          date,
          timeSlot,
          status: 'Scheduled',
          id: { not: consultation.id }
        }
      });
      if (existingConflict) {
        return res.status(400).json({
          success: false,
          message: 'This time slot is no longer available. Please select another time.'
        });
      }
    }

    // Atomic update of EXISTING consultation record ONLY
    const updatedConsultation = await prisma.consultation.update({
      where: { id: consultation.id },
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

    let lead = consultation.lead;
    if (!lead && consultation.leadId) {
      lead = await prisma.lead.findUnique({
        where: { id: consultation.leadId },
        include: { client: true }
      }).catch(() => null);
    }
    let client = lead?.client;
    if (!client && consultation.clientId) {
      client = await prisma.client.findUnique({
        where: { id: consultation.clientId }
      }).catch(() => null);
    }

    const clientName = lead ? `${lead.firstName} ${lead.lastName}` : (client ? `${client.firstName} ${client.lastName}` : 'Client');
    const email = lead?.email || client?.email || null;
    const phone = lead?.phone || client?.phone || null;
    const link = updatedConsultation.meetingLink || consultation.meetingLink || 'https://zoom.us';

    const dayjs = require('dayjs');
    const formattedDate = date ? (date.includes('-') ? dayjs(date).format('DD/MM/YYYY') : date) : date;

    const token = generateBookingToken(consultationId);
    const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
    const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultationId}`;
    const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultationId}`;
    const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

    // Send WhatsApp & Email Notifications
    if (phone) {
      try {
        const { sendCustomWhatsApp } = require('../services/chatbotService');
        const waMsg = `✈️ *Spain Visa Consultation Rescheduled!*

Dear *${clientName}*,

Your Spain Visa Consultation with *AAA Business Consultancy* has been scheduled successfully! 🎉

📅 *Date:* ${formattedDate}
⏰ *Time:* ${timeSlot} (UAE)
🔗 *Meeting Join Link:* ${link}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* ${rescheduleUrl}
• ❌ *Cancel Booking:* ${cancelUrl}
• 📦 *View Visa Packages:* ${packagesUrl}

_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`;

        sendCustomWhatsApp(phone, waMsg).catch(waErr => console.error('Reschedule WhatsApp error:', waErr.message));
        console.log(`[Reschedule WA Sent] Dispatched WhatsApp reschedule message to ${phone}`);
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
      message: 'Meeting rescheduled successfully',
      data: {
        bookingId: updatedConsultation.id,
        date: updatedConsultation.date,
        time: updatedConsultation.timeSlot,
        meetingLink: updatedConsultation.meetingLink,
        consultation: updatedConsultation
      }
    });
  } catch (error) {
    console.error('Error in publicRescheduleConsultation:', error);
    return res.status(500).json({ success: false, message: 'Failed to reschedule consultation.' });
  }
}

/**
 * Public Cancel Consultation (With strict 1-hour restriction)
 */
async function publicCancelConsultation(req, res) {
  try {
    const rawId = req.params.token || req.body.token || req.body.consultationId;

    if (!rawId) {
      return res.status(400).json({ success: false, message: 'Consultation token/ID is required.' });
    }

    const consultation = await findConsultationByIdOrToken(rawId);

    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Meeting could not be found.' });
    }

    if (consultation.status === 'Cancelled') {
      return res.status(400).json({ success: false, message: 'This meeting has already been cancelled.' });
    }

    // Meeting Cancellation Restriction (within 1 hour)
    const remainingHours = calculateRemainingHours(consultation.date, consultation.timeSlot);
    if (remainingHours <= 1.0) {
      return res.status(400).json({
        success: false,
        message: 'Meeting cannot be cancelled within 1 hour of the scheduled meeting time.'
      });
    }

    const updatedConsultation = await prisma.consultation.update({
      where: { id: consultation.id },
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

Your Spain Visa Eligibility Assessment scheduled for ${consultation.date} at ${consultation.timeSlot} (UAE) has been cancelled as requested.

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
              <p>Your Spain Visa Eligibility Assessment scheduled for <b>${consultation.date}</b> at <b>${consultation.timeSlot} (UAE)</b> has been cancelled.</p>
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

module.exports = {
  getConsultations,
  createConsultation,
  updateOutcome,
  respondToConsultation,
  createConsultationForLead,
  reassignConsultant,
  publicRescheduleConsultation,
  publicCancelConsultation,
  getPublicConsultationDetails,
  generateBookingToken,
  resolveConsultationId
};

