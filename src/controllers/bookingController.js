const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { remindersQueue, noShowEnforcerQueue } = require('../queues/queueSetup');
const { extractText } = require('unpdf');
const { sendEmail } = require('../services/emailService');
const { sendWhatsAppMessage } = require('../services/whatsappService');
const zoomService = require('../services/zoomService');

exports.createEligibilityBooking = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      nationality,
      countryOfResidence,
      preferredLanguage,
      serviceType,
      applicantsCount,
      deviceFingerprint,
      date,
      timeSlot,
      selectedVisa,
      preferableArea,
      budget,
      sourceLanguage,
      targetLanguage,
      wordCount,
    } = req.body;

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

    // 1. Anti-Fraud & Identity Normalization
    const normalizedPhone = phone.replace(/[\s\-\+]/g, ''); // strip spaces, dashes, country code prefix (naively for now)

    // 2. Check for Blocking (Cross-Device Detection)
    const blockedClient = await prisma.client.findFirst({
      where: {
        isBlocked: true,
        OR: [
          { email: email.toLowerCase() },
          { phone: { contains: normalizedPhone } }, // Fuzzy match
          ...(deviceFingerprint ? [{ deviceFingerprint }] : [])
        ]
      }
    });

    if (blockedClient) {
      return res.status(403).json({
        success: false,
        code: 'BLOCKED',
        message: 'Your booking cannot be processed automatically. Contact support.',
      });
    }

    // 2b. Check for BlacklistedClient (missed prior appointments)
    const blacklisted = await prisma.blacklistedClient.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { phone: { contains: normalizedPhone } }
        ]
      }
    });

    const { isNameSimilar } = require('../utils/fuzzyMatch');
    const blacklist = await prisma.blacklistedClient.findMany();
    const fullNameInput = `${firstName || ''} ${lastName || ''}`.trim();
    const matchesBlacklistByName = blacklist.some(b => isNameSimilar(fullNameInput, b.name));

    if (blacklisted || matchesBlacklistByName) {
      return res.status(403).json({
        success: false,
        code: 'BLACKLISTED',
        message: 'This profile is not eligible for further eligibility assessments due to a previous missed appointment.',
      });
    }

    // 2b. Check if an active Client already exists with this email or phone
    const existingClient = await prisma.client.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { phone: { contains: normalizedPhone } }
        ]
      }
    });

    if (existingClient) {
      return res.status(409).json({
        success: false,
        code: 'EXISTING_CLIENT',
        message: 'An active client profile already exists under this email/phone number.'
      });
    }

    // 2c. Check for Duplicate Active Bookings (Status-aware based on Most Recent Lead)
    const latestLead = await prisma.lead.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { phone: { contains: normalizedPhone } }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const inactiveStatuses = ['Lost Lead', 'Spam', 'Cold Lead', 'No Show', 'Completed', 'Cancelled', 'Canceled', 'Refused', 'Meeting Completed', 'Meeting Cancelled'];
    
    if (latestLead && !inactiveStatuses.includes(latestLead.status)) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_LEAD',
        message: 'You already have an active booking or application under this email/phone.',
      });
    }

    // 3. Smart Consultant Assignment matching
    const consultants = await prisma.user.findMany({
      where: { role: 'consultant' },
      include: {
        _count: {
          select: { assignedLeads: true }
        }
      }
    });

    let bestConsultantId = null;
    let highestScore = -999;
    let minActiveLeads = Infinity;

    for (const consultant of consultants) {
      let score = 0;

      // Spoken Language Match
      if (preferredLanguage && consultant.spokenLanguages) {
        try {
          const spoken = Array.isArray(consultant.spokenLanguages)
            ? consultant.spokenLanguages
            : JSON.parse(JSON.stringify(consultant.spokenLanguages));
          if (spoken.map(s => s.toLowerCase()).includes(preferredLanguage.toLowerCase())) {
            score += 10;
          }
        } catch (e) {
          console.warn("Spoken languages parsing failed:", e.message);
        }
      }

      // Property Specialist Match
      const normalizedService = (serviceType || '').toLowerCase();
      if (normalizedService.includes('property')) {
        if (consultant.isPropertySpecialist) {
          score += 20;
        } else {
          score -= 10;
        }
      } else {
        // Visa/Residency or Case Assessment Match
        const visa = (selectedVisa || '').toLowerCase();
        if (visa && consultant.visaExpertise) {
          try {
            const expertise = Array.isArray(consultant.visaExpertise)
              ? consultant.visaExpertise
              : JSON.parse(JSON.stringify(consultant.visaExpertise));
            if (expertise.map(v => v.toLowerCase()).includes(visa)) {
              score += 15;
            }
          } catch (e) {
            console.warn("Visa expertise parsing failed:", e.message);
          }
        }
      }

      // Nationality Match
      if (nationality && consultant.nationalities) {
        try {
          const natList = Array.isArray(consultant.nationalities)
            ? consultant.nationalities
            : JSON.parse(JSON.stringify(consultant.nationalities));
          if (natList.map(n => n.toLowerCase()).includes(nationality.toLowerCase())) {
            score += 5;
          }
        } catch (e) {
          console.warn("Nationalities parsing failed:", e.message);
        }
      }

      // Load-balancing helper
      const activeLeadsCount = consultant._count?.assignedLeads || 0;

      // Selection logic: Highest score. Tiebreaker is lower workload.
      if (score > highestScore) {
        highestScore = score;
        bestConsultantId = consultant.id;
        minActiveLeads = activeLeadsCount;
      } else if (score === highestScore) {
        if (activeLeadsCount < minActiveLeads) {
          bestConsultantId = consultant.id;
          minActiveLeads = activeLeadsCount;
        }
      }
    }

    // 4. Find or Create Client
    let client = await prisma.client.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (!client) {
      client = await prisma.client.create({
        data: {
          firstName,
          lastName,
          email: email.toLowerCase(),
          phone,
          nationality,
          countryOfResidence,
          preferredLanguage,
          serviceType,
          applicantsCount,
          deviceFingerprint,
          preferableArea: preferableArea || null,
          budget: budget || null,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: targetLanguage || null,
          wordCount: wordCount ? parseInt(wordCount, 10) : null,
          status: 'Waiting for Assessment',
          assignedToId: bestConsultantId
        }
      });
    } else {
      // Update device fingerprint & assignment if missing
      await prisma.client.update({
        where: { id: client.id },
        data: {
          deviceFingerprint: deviceFingerprint || undefined,
          assignedToId: client.assignedToId || bestConsultantId,
          preferableArea: preferableArea || undefined,
          budget: budget || undefined
        }
      });
    }

    // 5. Create Lead (if doesn't exist for UI compatibility)
    let lead = await prisma.lead.findUnique({ where: { clientId: client.id } });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          firstName, lastName, email: email.toLowerCase(), phone, nationality, countryOfResidence,
          preferredLanguage, serviceType, applicantsCount, status: 'Meeting Scheduled',
          clientId: client.id,
          assignedToId: bestConsultantId,
          preferableArea: preferableArea || null,
          budget: budget || null,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: targetLanguage || null,
          wordCount: wordCount ? parseInt(wordCount, 10) : null
        }
      });
    } else {
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: {
          status: 'Meeting Scheduled',
          assignedToId: lead.assignedToId || bestConsultantId,
          preferableArea: preferableArea || undefined,
          budget: budget || undefined,
          sourceLanguage: sourceLanguage || undefined,
          targetLanguage: targetLanguage || undefined,
          wordCount: wordCount ? parseInt(wordCount, 10) : undefined
        }
      });
    }

    console.log(`[BOOKING] Booking submission received for: ${firstName} ${lastName} (${email})`);
    console.log(`[BOOKING] Consultant assigned: ${bestConsultantId}`);

    // 6. Create Application Cycle
    const appCycle = await prisma.applicationCycle.create({
      data: {
        clientId: client.id,
        serviceType,
        status: 'Assessment Booked'
      }
    });

    // Idempotency check: Reuse existing consultation or meetingLink if available
    let existingConsultation = await prisma.consultation.findFirst({
      where: { leadId: lead.id }
    });

    let meetingLink = existingConsultation?.meetingLink || null;
    let zoomFailed = false;

    if (!meetingLink) {
      console.log(`[ZOOM] Creating meeting for ${firstName} ${lastName} on ${date} at ${timeSlot}`);
      if (zoomService.isConfigured) {
        try {
          let startTimeISO = new Date().toISOString();
          const timeStr = timeSlot && timeSlot.includes(':') ? timeSlot : '10:00';
          const dateObj = new Date(`${date}T${timeStr}`);
          if (!isNaN(dateObj.getTime())) {
            startTimeISO = dateObj.toISOString();
          }

          const zoomMeeting = await zoomService.createZoomMeeting({
            topic: `Eligibility Assessment for ${firstName} ${lastName}`,
            startTime: startTimeISO,
            durationMinutes: 20
          });

          if (zoomMeeting && zoomMeeting.joinUrl) {
            meetingLink = zoomMeeting.joinUrl;
            console.log(`[ZOOM] Meeting created successfully: ${meetingLink}`);
          }
        } catch (zoomErr) {
          console.error('[ZOOM] Meeting creation failed:', zoomErr.message);
          zoomFailed = true;
        }
      }

      if (!meetingLink && !zoomFailed) {
        console.log('[ZOOM] Zoom service not configured. Generating mock meeting link.');
        meetingLink = `https://zoom.us/j/${Math.floor(Math.random() * 9000000000 + 1000000000)}`;
      }
    } else {
      console.log(`[ZOOM] Reusing existing meetingLink: ${meetingLink}`);
    }

    const consultationStatus = (zoomFailed && !meetingLink) ? 'Pending Zoom' : 'Scheduled';

    // 7. Create or Update Booking (Consultation)
    let consultation;
    if (!existingConsultation) {
      consultation = await prisma.consultation.create({
        data: {
          date,
          timeSlot,
          status: consultationStatus,
          leadId: lead.id,
          meetingLink,
          consultantId: bestConsultantId,
          type: (serviceType || '').toLowerCase().includes('property') ? 'property_guidance' : 'eligibility'
        }
      });
    } else {
      consultation = await prisma.consultation.update({
        where: { id: existingConsultation.id },
        data: {
          date,
          timeSlot,
          status: consultationStatus,
          meetingLink: meetingLink || existingConsultation.meetingLink,
          consultantId: bestConsultantId
        }
      });
    }

    if (consultationStatus === 'Scheduled') {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'Meeting Scheduled' }
      }).catch(err => console.error('[BOOKING] Failed to update lead status:', err.message));
      console.log(`[BOOKING] Consultation marked Scheduled for Lead ID: ${lead.id}`);
    }

    // 7. Create CRM Notification Record & Broadcast Real-Time Socket Event
    try {
      await prisma.notification.create({
        data: {
          userId: bestConsultantId || 'admin',
          type: 'new_booking',
          title: 'New Consultation Booked 📅',
          body: `New assessment booked for ${firstName} ${lastName} on ${date} at ${timeSlot}.`,
          clientId: client.id
        }
      });
    } catch (notifErr) {
      console.warn('[CRM Notification] Failed to create DB notification:', notifErr.message);
    }

    try {
      const io = req.app.get('io');
      if (io) {
        io.to('role:admin').to('role:consultant').to(`user:${bestConsultantId}`).emit('new_booking', {
          consultation,
          client,
          lead
        });
        console.log(`[SOCKET] new_booking emitted for Consultation ID: ${consultation.id}`);
      }
    } catch (ioErr) {
      console.warn('[SOCKET] Broadcast warning:', ioErr.message);
    }

    // Trigger In-App Notifications for all staff
    try {
      const { createLeadNotification } = require('./notificationController');
      createLeadNotification({
        leadName: `${firstName} ${lastName}`,
        email: email.toLowerCase(),
        phone,
        country: countryOfResidence,
        serviceCategory: serviceType,
        appointmentDate: `${date} ${timeSlot}`,
        reqApp: req.app
      }).catch(err => console.error('[Booking Notification Error]:', err.message));
    } catch (notifErr) {
      console.error('[Booking Notification Init Error]:', notifErr.message);
    }

    // 7. Enqueue Reminders and No-Show Enforcer Jobs
    // Assuming meeting date/time is parsed to a JS Date object `meetingStart`
    const meetingStart = new Date(`${date} ${timeSlot}`); // Naive parsing
    const tenMinsAfterStart = new Date(meetingStart.getTime() + 10 * 60000);

    // Schedule NO-SHOW enforcer precisely at meetingStart + 10 mins
    const delay = tenMinsAfterStart.getTime() - Date.now();

    if (delay > 0) {
      await noShowEnforcerQueue.add('enforce-no-show', {
        consultationId: consultation.id,
        clientId: client.id,
      }, {
        jobId: `noshow-${consultation.id}`,
        delay: delay
      });
    }

    // Asynchronously trigger instant Email and WhatsApp confirmations + reminders
    (async () => {
      try {
        const clientName = `${firstName} ${lastName}`;
        const link = meetingLink || 'https://zoom.us';

        console.log(`[NOTIFICATIONS] Dispatching booking confirmation for Lead: ${clientName} (${phone} / ${email})`);

        const { generateBookingToken } = require('./consultationController');
        const token = generateBookingToken(consultation.id);
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;
        const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultation.id}`;
        const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

        // 1 & 2. Send WhatsApp Message and Branded Email via centralized service
        try {
          const { notifyClient } = require('../services/notificationService');
          await notifyClient({
            event: 'MEETING_BOOKED',
            clientId: client.id,
            consultationId: consultation.id,
            data: {
              date,
              time: timeSlot,
              link
            }
          });
        } catch (notifErr) {
          console.error('[NOTIFICATIONS] Failed to trigger central notification:', notifErr.message);
        }

        // 3. Schedule 3 Reminders (24h, 1h, 10m before)
        if (remindersQueue && remindersQueue.add) {
          const mStart = new Date(`${date}T${timeSlot.includes(':') ? timeSlot : '10:00'}`);
          if (!isNaN(mStart.getTime())) {
            const now = Date.now();

            const scheduleReminder = async (label, timeBeforeMs, subject, textLabel) => {
              const reminderTime = mStart.getTime() - timeBeforeMs;
              const dly = reminderTime - now;
              if (dly > 0) {
                await remindersQueue.add('send-reminder', {
                  toEmail: email,
                  toPhone: phone,
                  subject: subject,
                  emailHtml: `<h3>Meeting Reminder</h3><p>Dear ${firstName}, your Spain Visa Consultation is in ${textLabel}.</p><p>Zoom Join Link: <a href="${link}">${link}</a></p>`,
                  whatsappTemplate: 'consultation_scheduled_confirmation',
                  whatsappComponents: [
                    {
                      type: 'body',
                      parameters: [
                        { type: 'text', text: firstName },
                        { type: 'text', text: date },
                        { type: 'text', text: timeSlot },
                        { type: 'text', text: link }
                      ]
                    }
                  ]
                }, {
                  jobId: `reminder-${label}-${consultation.id}`,
                  delay: dly
                });
                console.log(`[NOTIFICATIONS] Enqueued ${label} reminder with delay: ${Math.round(dly / 60000)} minutes`);
              }
            };

            await scheduleReminder('24h', 24 * 60 * 60 * 1000, 'Reminder: Spain Visa Consultation in 24 Hours', '24 Hours');
            await scheduleReminder('1h', 1 * 60 * 60 * 1000, 'Reminder: Spain Visa Consultation in 1 Hour', '1 Hour');
            await scheduleReminder('10m', 10 * 60 * 1000, 'Urgent Reminder: Spain Visa Consultation in 10 Minutes', '10 Minutes');
          }
        }
      } catch (err) {
        console.error('[NOTIFICATIONS] Error sending booking confirmation:', err);
      }
    })().catch(err => console.error('[NOTIFICATIONS] Async error:', err));

    return res.status(201).json({
      success: true,
      message: 'Booking confirmed successfully',
      data: { consultation, client }
    });

  } catch (error) {
    console.error('Eligibility Booking Error:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

async function getTranslationRate(sourceLanguage) {
  const lang = (sourceLanguage || 'English').toLowerCase().trim();

  // Try to load dynamic rates from DB settings
  try {
    const settings = await prisma.companySetting.findFirst({
      select: { swornTranslationRates: true }
    }).catch(() => null);
    if (settings && settings.swornTranslationRates) {
      const rates = typeof settings.swornTranslationRates === 'string'
        ? JSON.parse(settings.swornTranslationRates)
        : settings.swornTranslationRates;

      if (Array.isArray(rates)) {
        const found = rates.find(r => {
          const n = (r.name || '').toLowerCase();
          return (lang.includes('urdu') && n.includes('urdu')) ||
                 (lang.includes('arabic') && n.includes('arabic')) ||
                 (lang.includes('english') && n.includes('english')) ||
                 n.includes(lang);
        });
        if (found && found.rate !== undefined) {
          return parseFloat(found.rate);
        }
      } else if (typeof rates === 'object') {
        if (lang.includes('urdu') && rates.urduToSpanish) return parseFloat(rates.urduToSpanish);
        if (lang.includes('arabic') && rates.arabicToSpanish) return parseFloat(rates.arabicToSpanish);
        if (lang.includes('english') && rates.englishToSpanish) return parseFloat(rates.englishToSpanish);
      }
    }
  } catch (e) {
    console.warn("Failed to fetch custom translation rates:", e.message);
  }

  // Fallback defaults
  if (lang.includes('urdu')) {
    return 0.40;
  }
  if (lang.includes('arabic')) {
    return 0.25;
  }
  // Default (English)
  return 0.15;
}

async function calculateSwornTranslationPrice(wordCount, sourceLanguage) {
  const rate = await getTranslationRate(sourceLanguage);
  const subtotal = parseFloat((wordCount * rate).toFixed(2));
  const vat = parseFloat((subtotal * 0.05).toFixed(2));
  const total = parseFloat((subtotal + vat).toFixed(2));
  return { rate, subtotal, vat, total };
}

exports.uploadTranslationDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ success: false, message: 'Only PDF files are supported' });
    }

    // Parse PDF using unpdf extractText with a 5-second timeout protection
    const extractPromise = extractText(new Uint8Array(req.file.buffer));
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('PDF text extraction timed out (5s limit)')), 5000)
    );
    const pdfData = await Promise.race([extractPromise, timeoutPromise]).catch(err => {
      console.warn('[PDF Parse Sworn Translation] Text extraction failed or timed out:', err.message);
      return { text: '' };
    });
    const text = Array.isArray(pdfData.text) ? pdfData.text.join(' ') : (pdfData.text || '');

    // Count words (naive whitespace split)
    const wordCount = text.trim().split(/\s+/).filter(word => word.length > 0).length;

    const {
      firstName,
      lastName,
      email,
      phone,
      nationality,
      sourceLanguage,
      targetLanguage
    } = req.body;

    const sourceLang = sourceLanguage || 'English';
    const priceDetails = await calculateSwornTranslationPrice(wordCount, sourceLang);

    // Save/Update Lead in CRM database upon requesting quote (Sworn Translation stays in Lead)
    if (firstName && lastName && email && phone) {
      try {
        const filename = req.file?.filename || req.file?.key || `${Date.now()}-${req.file?.originalname || 'document.pdf'}`;
        const fileUrl = req.file?.location || `/uploads/${filename}`;
        const fileSizeMb = req.file?.size ? (req.file.size / 1024 / 1024).toFixed(2) : '0.10';

        const docObj = {
          documentName: req.file?.originalname || 'Translation Document.pdf',
          documentUrl: fileUrl,
          documentSize: `${fileSizeMb} MB`,
          wordCount,
          sourceLanguage: sourceLang,
          targetLanguage: targetLanguage || 'Spanish',
          estimatedPrice: priceDetails.total,
          uploadedAt: new Date().toISOString()
        };

        let lead = await prisma.lead.findFirst({
          where: {
            OR: [
              { email: email.toLowerCase() },
              { phone: phone }
            ]
          }
        });

        if (!lead) {
          const totalLeads = await prisma.lead.count();
          const totalClients = await prisma.client.count();
          const autoClientCode = `CID-${12001 + totalLeads + totalClients}`;

          await prisma.lead.create({
            data: {
              clientCode: autoClientCode,
              firstName,
              lastName,
              email: email.toLowerCase(),
              phone,
              nationality: nationality || null,
              serviceType: 'Spanish Sworn Translation',
              status: 'Payment Not Completed',
              sourceLanguage: sourceLang,
              targetLanguage: targetLanguage || 'Spanish',
              wordCount: wordCount,
              qualificationData: {
                serviceType: 'Spanish Sworn Translation',
                ...docObj
              }
            }
          });
        } else {
          let existingQual = lead.qualificationData || {};
          if (typeof existingQual !== 'object') existingQual = {};
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              serviceType: 'Spanish Sworn Translation',
              status: 'Payment Not Completed',
              phone: phone || undefined,
              nationality: nationality || undefined,
              sourceLanguage: sourceLang,
              targetLanguage: targetLanguage || 'Spanish',
              wordCount: wordCount,
              qualificationData: {
                ...existingQual,
                serviceType: 'Spanish Sworn Translation',
                ...docObj
              }
            }
          });
        }
      } catch (crmErr) {
        console.warn('[CRM Save Warning in Upload]:', crmErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        wordCount,
        rate: priceDetails.rate,
        subtotal: priceDetails.subtotal,
        vat: priceDetails.vat,
        estimatedPrice: priceDetails.total,
        currency: 'EUR'
      }
    });

  } catch (error) {
    console.error('PDF Parse Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to parse PDF document' });
  }
};

exports.checkoutTranslationDocument = async (req, res) => {
  const crypto = require('crypto');
  const bcrypt = require('bcrypt');

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      nationality,
      sourceLanguage,
      targetLanguage,
      wordCount,
      estimatedPrice
    } = req.body;

    if (!firstName || !lastName || !email || !phone) {
      return res.status(400).json({ success: false, message: 'Missing required client details' });
    }

    // 1. Find or create Lead (Sworn Translation stays strictly in Lead section)
    let lead = await prisma.lead.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          { phone: phone }
        ]
      }
    });

    let autoClientCode;
    let suffix = 0;
    let isUnique = false;
    while (!isUnique) {
      const totalLeads = await prisma.lead.count();
      const totalClients = await prisma.client.count();
      autoClientCode = `CID-${12001 + totalLeads + totalClients + suffix}`;
      const checkClient = await prisma.client.findFirst({ where: { clientCode: autoClientCode } });
      const checkLead = await prisma.lead.findFirst({ where: { clientCode: autoClientCode } });
      if (!checkClient && !checkLead) isUnique = true;
      else suffix++;
    }

    // 2. Prepare uploaded document details
    let category = req.body.category || 'Translation Input';
    if (category.startsWith('Other: ')) {
      category = category.replace('Other: ', '');
    }

    const filename = req.file.filename || req.file.key || `${Date.now()}-${req.file.originalname || 'document.pdf'}`;
    const fileUrl = req.file.location || `/uploads/${filename}`;
    const fileSizeMb = req.file.size ? (req.file.size / 1024 / 1024).toFixed(2) : '0.10';

    const parsedWordCount = parseInt(wordCount, 10) || 0;
    const priceDetails = await calculateSwornTranslationPrice(parsedWordCount, sourceLanguage || 'English');
    let finalPrice = priceDetails.total || 15.00;
    if (estimatedPrice) {
      const parsedReqPrice = parseFloat(estimatedPrice);
      if (!isNaN(parsedReqPrice) && parsedReqPrice > 0) {
        finalPrice = parsedReqPrice;
      }
    }

    const docObj = {
      name: req.file.originalname || 'Translation Document.pdf',
      category: category,
      url: fileUrl,
      size: `${fileSizeMb} MB`,
      wordCount: parsedWordCount,
      sourceLanguage: sourceLanguage || 'English',
      targetLanguage: targetLanguage || 'Spanish',
      estimatedPrice: finalPrice,
      uploadedAt: new Date().toISOString()
    };

    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          clientCode: autoClientCode,
          firstName,
          lastName,
          email: email.toLowerCase(),
          phone,
          nationality: nationality || null,
          serviceType: 'Spanish Sworn Translation',
          status: 'Payment Not Completed',
          sourceLanguage: sourceLanguage || 'English',
          targetLanguage: targetLanguage || 'Spanish',
          wordCount: parsedWordCount,
          qualificationData: {
            serviceType: 'Spanish Sworn Translation',
            documentName: docObj.name,
            documentUrl: docObj.url,
            documentSize: docObj.size,
            wordCount: docObj.wordCount,
            sourceLanguage: docObj.sourceLanguage,
            targetLanguage: docObj.targetLanguage,
            estimatedPrice: docObj.estimatedPrice,
            uploadedAt: docObj.uploadedAt
          }
        }
      });
    } else {
      let existingQual = lead.qualificationData || {};
      if (typeof existingQual !== 'object') existingQual = {};
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: {
          serviceType: 'Spanish Sworn Translation',
          status: 'Payment Not Completed',
          sourceLanguage: sourceLanguage || 'English',
          targetLanguage: targetLanguage || 'Spanish',
          wordCount: parsedWordCount,
          qualificationData: {
            ...existingQual,
            serviceType: 'Spanish Sworn Translation',
            documentName: docObj.name,
            documentUrl: docObj.url,
            documentSize: docObj.size,
            wordCount: docObj.wordCount,
            sourceLanguage: docObj.sourceLanguage,
            targetLanguage: docObj.targetLanguage,
            estimatedPrice: docObj.estimatedPrice,
            uploadedAt: docObj.uploadedAt
          }
        }
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || req.headers.origin || 'http://localhost:5173';
    let paymentUrl = `${frontendUrl}/#/public/translation?success=true&leadId=${lead.id}`;

    return res.status(201).json({
      success: true,
      message: 'Sworn translation document lead submitted successfully',
      data: {
        leadId: lead.id,
        paymentUrl,
        estimatedPrice: finalPrice
      }
    });

  } catch (error) {
    console.error('Translation Checkout Error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal Server Error during checkout' });
  }
};

exports.verifyPrefillToken = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }

    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../config/jwt');
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtErr) {
      return res.status(401).json({ success: false, message: 'Invalid or expired re-booking token' });
    }

    const { clientId } = decoded;
    if (!clientId) {
      return res.status(400).json({ success: false, message: 'Invalid token payload' });
    }

    // Retrieve client details
    const client = await prisma.client.findUnique({
      where: { id: clientId }
    });

    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    return res.status(200).json({
      success: true,
      data: {
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        nationality: client.nationality || '',
        countryOfResidence: client.countryOfResidence || '',
        preferredLanguage: client.preferredLanguage || 'English',
        serviceType: client.serviceType || '',
        applicantsCount: client.applicantsCount || 'Main Only',
        preferableArea: client.preferableArea || '',
        budget: client.budget || ''
      }
    });

  } catch (error) {
    console.error('Error verifying prefill token:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
};

const consultationController = require('./consultationController');

exports.getRescheduleDetails = consultationController.getPublicConsultationDetails;
exports.rescheduleBooking = consultationController.publicRescheduleConsultation;
exports.cancelBooking = consultationController.publicCancelConsultation;

