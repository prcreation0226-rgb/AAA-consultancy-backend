const prisma = require('../config/db');

const getLeads = async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        countryOfResidence: true,
        preferredLanguage: true,
        serviceType: true,
        applicantsCount: true,
        source: true,
        campaignId: true,
        status: true,
        notes: true,
        timeline: true,
        qualificationData: true,
        dependentsDetails: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true,
        preferableArea: true,
        budget: true,
        sourceLanguage: true,
        targetLanguage: true,
        wordCount: true,
        createdAt: true,
        updatedAt: true,
        assignedToId: true,
        assignedAt: true,
        nextFollowUpDate: true,
        clientId: true,
        assignedTo: {
          select: { fullName: true }
        },
        client: {
          select: {
            id: true,
            clientCode: true,
            documents: {
              select: { id: true, name: true, status: true, url: true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    // Map to frontend expectation
    const mapped = leads.map((l, idx) => {
      const autoCode = l.client?.clientCode || `CID-${12001 + (leads.length - 1 - idx)}`;
      return {
        ...l,
        createdDate: l.createdAt,
        assignedAt: l.assignedAt || l.createdAt,
        name: `${l.firstName} ${l.lastName}`,
        serviceId: l.serviceType,
        assignedConsultantId: l.assignedToId,
        assignedConsultantName: l.assignedTo?.fullName,
        clientCode: autoCode,
        displayId: autoCode,
        documents: l.client?.documents || []
      };
    });
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching leads', error: error.message });
  }
};

const createLead = async (req, res) => {
  try {
    const {
      firstName, 
      lastName, 
      email, 
      phone, 
      source, 
      campaignId, 
      serviceType, 
      serviceId, 
      nationality, 
      countryOfResidence,
      preferredLanguage, 
      applicantsCount,
      dependentsDetails,
      meetingPreferredDate,
      meetingPreferredTime,
      meetingPreferredLanguage,
      meetingNotes,
      qualificationData,
      preferableArea,
      budget,
      sourceLanguage,
      targetLanguage,
      wordCount
    } = req.body;

    // Same-Day Booking Restriction
    if (meetingPreferredDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (meetingPreferredDate <= todayStr) {
        return res.status(400).json({
          success: false,
          message: 'Booking date must be at least the next calendar day.'
        });
      }
    }
    
    const safeEmail = email ? email.trim().toLowerCase() : '';
    // Normalize phone number to check for existing lead (last 10 digits to match with or without country code)
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const matchDigits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

    // 1. Check blocked client
    const blockedClient = await prisma.client.findFirst({
      where: {
        isBlocked: true,
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    if (blockedClient) {
      return res.status(403).json({
        code: 'BLOCKED',
        message: 'Your booking cannot be processed automatically. Contact support.'
      });
    }

    // 2. Check blacklist first
    const blacklisted = await prisma.blacklistedClient.findFirst({
      where: {
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    const { isNameSimilar } = require('../utils/fuzzyMatch');
    const blacklist = await prisma.blacklistedClient.findMany();
    const fullNameInput = `${firstName || ''} ${lastName || ''}`.trim();
    const matchesBlacklistByName = blacklist.some(b => isNameSimilar(fullNameInput, b.name));

    if (blacklisted || matchesBlacklistByName) {
      return res.status(403).json({
        code: 'BLACKLISTED',
        message: 'This profile is not eligible for further eligibility assessments due to a previous missed appointment.'
      });
    }

    // 2b. Check if an active Client already exists with this email or phone
    const existingClient = await prisma.client.findFirst({
      where: {
        OR: [
          ...(safeEmail ? [{ email: safeEmail }] : []),
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      }
    });

    if (existingClient) {
      return res.status(409).json({
        code: 'EXISTING_CLIENT',
        message: 'An active client profile already exists under this email or phone number. A new lead cannot be created.'
      });
    }
    
    // 3. Check for Duplicate Active Bookings for Public Form Submissions
    if (!req.user) {
      const latestLead = await prisma.lead.findFirst({
        where: {
          OR: [
            ...(safeEmail ? [{ email: safeEmail }] : []),
            ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
          ]
        },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' }
      });

      const inactiveStatuses = ['Lost Lead', 'Spam', 'Cold Lead', 'No Show', 'Completed', 'Cancelled', 'Canceled', 'Refused', 'Meeting Completed', 'Meeting Cancelled'];
      
      if (latestLead && !inactiveStatuses.includes(latestLead.status)) {
        return res.status(409).json({
          code: 'DUPLICATE_LEAD',
          message: 'An active booking or application already exists under this email or phone number.'
        });
      }
    }

    let lead = null;

    // Smart auto-assign: prefer property specialist for Property Investment leads
    const finalServiceType = serviceType || serviceId || '';
    const isPropertyLead = finalServiceType.toLowerCase().includes('property') || finalServiceType.toLowerCase().includes('investment');
    let assignedToId = null;
    if (isPropertyLead) {
      // Try to find a property specialist first
      const propertySpecialists = await prisma.user.findMany({ where: { role: 'consultant', isPropertySpecialist: true } });
      if (propertySpecialists.length > 0) {
        assignedToId = propertySpecialists[0].id;
      } else {
        // Fallback to any available consultant
        const consultants = await prisma.user.findMany({ where: { role: 'consultant' } });
        assignedToId = consultants.length > 0 ? consultants[0].id : null;
      }
    } else {
      // Normal assignment for non-property leads
      let ruleMatched = false;
      const settings = await prisma.companySetting.findFirst();
      if (settings && settings.routingRules && Array.isArray(settings.routingRules)) {
        const leadNat = (nationality || '').toLowerCase();
        const leadCountry = (countryOfResidence || '').toLowerCase();
        
        const rule = settings.routingRules.find(r => {
          const ruleNat = (r.nationality || '').toLowerCase();
          const ruleCountry = (r.country || '').toLowerCase();
          const natMatch = ruleNat && leadNat.includes(ruleNat);
          const countryMatch = ruleCountry && leadCountry.includes(ruleCountry);
          return natMatch || countryMatch;
        });
        
        if (rule && rule.consultantId) {
          assignedToId = rule.consultantId;
          ruleMatched = true;
        }
      }

      if (!ruleMatched) {
        // Normal round-robin assignment fallback
        const consultants = await prisma.user.findMany({ where: { role: 'consultant' } });
        assignedToId = consultants.length > 0 ? consultants[0].id : null;
      }
    }

    // Create new lead (compatible with Railway schema)
    lead = await prisma.lead.create({
        data: {
          firstName: firstName || '',
          lastName: lastName || '',
          email: safeEmail || email || '',
          phone: phone || '',
          source: source || 'Website',
          campaignId,
          serviceType: serviceType || serviceId,
          nationality,
          countryOfResidence: countryOfResidence || null,
          preferredLanguage: preferredLanguage || 'English',
          applicantsCount: applicantsCount ? String(applicantsCount) : undefined,
          dependentsDetails: dependentsDetails || undefined,
          meetingPreferredDate,
          meetingPreferredTime,
          meetingPreferredLanguage,
          meetingNotes,
          qualificationData: qualificationData || undefined,
          assignedToId,
          assignedAt: assignedToId ? new Date() : null,
          preferableArea: preferableArea || null,
          budget: budget || null,
          sourceLanguage: sourceLanguage || null,
          targetLanguage: targetLanguage || null,
          wordCount: wordCount ? parseInt(wordCount, 10) : null,
          formSubmittedAt: meetingPreferredDate ? new Date() : undefined,
          status: meetingPreferredDate ? 'Form Submitted' : 'New Lead'
        }
      });
      console.log(`New Lead created (ID: ${lead.id}, Phone: ${lead.phone})`);

      // Trigger In-App Notifications for all staff
      const { createLeadNotification } = require('./notificationController');
      createLeadNotification({
        leadName: `${lead.firstName} ${lead.lastName}`,
        email: lead.email,
        phone: lead.phone,
        country: lead.countryOfResidence,
        serviceCategory: lead.serviceType,
        appointmentDate: lead.meetingPreferredDate ? `${lead.meetingPreferredDate} ${lead.meetingPreferredTime || ''}` : null,
        reqApp: req.app
      }).catch(err => console.error('[Lead Notification Error]:', err.message));

    // Synchronously create consultation and Zoom link so instant link is returned immediately
    let consultation = null;
    try {
      consultation = await syncLeadConsultation(lead.id, req.app);
    } catch (syncErr) {
      console.error('[SYNC] Error in syncLeadConsultation:', syncErr.message);
    }

    res.status(201).json({
      ...lead,
      consultation,
      meetingLink: consultation?.meetingLink
    });
  } catch (error) {
    console.error('Error in createLead:', error);
    res.status(500).json({ message: 'Server error creating lead', error: error.message });
  }
};

const assignLead = async (req, res) => {
  try {
    const { leadId, agentId } = req.body;
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { assignedToId: agentId, assignedAt: new Date() },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        assignedToId: true,
        assignedAt: true,
        clientId: true
      }
    });

    // Update consultant on any existing active (non-cancelled) consultation directly in DB
    await prisma.consultation.updateMany({
      where: { leadId, status: { notIn: ['Cancelled'] } },
      data: { consultantId: agentId, assignedAt: new Date() }
    }).catch(err => console.warn('[assignLead] Consultation update warning:', err.message));

    // Also update associated client assignedToId if exists
    if (lead.clientId) {
      await prisma.client.update({
        where: { id: lead.clientId },
        data: { assignedToId: agentId, assignedAt: new Date() }
      }).catch(err => console.warn('[assignLead] Client update warning:', err.message));
    }

    res.json(lead);
  } catch (error) {
    console.error('Error assigning lead:', error);
    res.status(500).json({ message: 'Server error assigning lead', error: error.message });
  }
};

const updateLeadStatus = async (req, res) => {
  try {
    const { leadId, status } = req.body;
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true
      }
    });

    if (status === 'No Show' || status === 'No-Show') {
      try {
        await prisma.blacklistedClient.upsert({
          where: { email: lead.email.toLowerCase() },
          update: { phone: lead.phone || '' },
          create: {
            email: lead.email.toLowerCase(),
            name: `${lead.firstName} ${lead.lastName}`,
            phone: lead.phone || ''
          }
        });
        console.log(`[Blacklist] Blacklisted client on No Show status: ${lead.email}`);
      } catch (dbErr) {
        console.error('[Blacklist] Failed to insert blacklist record:', dbErr.message);
      }
    }

    const { logActivity } = require('../services/auditService');
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'System';
    const actorRole = req.user ? (req.user.role || 'staff') : 'system';
    logActivity({
      leadId: lead.id,
      actorId: req.user?.id || 'system',
      actorName,
      actorRole,
      action: 'STATUS_CHANGED',
      description: `Lead status updated to "${status}" by ${actorName}.`
    });

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating status' });
  }
};

const deleteLead = async (req, res) => {
  try {
    if (req.user && req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Only Super Admin has permission to delete leads.' });
    }
    const { id } = req.params;

    // Delete associated consultations first to avoid foreign key constraint violations
    await prisma.consultation.deleteMany({
      where: { leadId: id }
    });

    // Delete the lead with explicit select
    const lead = await prisma.lead.delete({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true
      }
    });

    res.json({ success: true, message: 'Lead deleted successfully', lead });
  } catch (error) {
    console.error('Error deleting lead:', error.message);
    res.status(500).json({ message: 'Server error deleting lead', error: error.message });
  }
};

const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        countryOfResidence: true,
        preferredLanguage: true,
        serviceType: true,
        applicantsCount: true,
        source: true,
        campaignId: true,
        status: true,
        notes: true,
        timeline: true,
        qualificationData: true,
        dependentsDetails: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true,
        preferableArea: true,
        budget: true,
        sourceLanguage: true,
        targetLanguage: true,
        wordCount: true,
        createdAt: true,
        updatedAt: true,
        assignedToId: true,
        assignedAt: true,
        nextFollowUpDate: true,
        clientId: true,
        assignedTo: {
          select: { id: true, fullName: true }
        },
        client: {
          select: {
            id: true,
            clientCode: true,
            documents: {
              select: { id: true, name: true, status: true, url: true }
            }
          }
        }
      }
    });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const autoCode = lead.client?.clientCode || `CID-12001`;
    const mapped = {
      ...lead,
      name: `${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
      serviceId: lead.serviceType,
      assignedConsultantId: lead.assignedToId,
      assignedConsultantName: lead.assignedTo?.fullName,
      clientCode: autoCode,
      displayId: autoCode,
      documents: lead.client?.documents || []
    };
    res.json(mapped);
  } catch (error) {
    console.error('[getLeadById Error]:', error.message);
    res.status(500).json({ message: 'Server error fetching lead details', error: error.message });
  }
};

const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      firstName, 
      lastName, 
      email, 
      phone, 
      nationality, 
      preferredLanguage, 
      serviceId, 
      applicantsCount, 
      source, 
      campaignId, 
      status, 
      notes, 
      timeline, 
      qualificationData,
      assignedConsultantId,
      preferableArea,
      budget,
      sourceLanguage,
      targetLanguage,
      wordCount,
      nextFollowUpDate
    } = req.body;

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        firstName,
        lastName,
        email,
        phone,
        nationality,
        preferredLanguage,
        serviceType: serviceId,
        applicantsCount: applicantsCount ? String(applicantsCount) : undefined,
        source,
        campaignId,
        status,
        notes,
        timeline,
        qualificationData,
        assignedToId: assignedConsultantId,
        ...(assignedConsultantId ? { assignedAt: new Date() } : {}),
        nextFollowUpDate: nextFollowUpDate !== undefined ? (nextFollowUpDate ? new Date(nextFollowUpDate) : null) : undefined,
        preferableArea: preferableArea !== undefined ? preferableArea : undefined,
        budget: budget !== undefined ? budget : undefined,
        sourceLanguage: sourceLanguage !== undefined ? sourceLanguage : undefined,
        targetLanguage: targetLanguage !== undefined ? targetLanguage : undefined,
        wordCount: wordCount !== undefined ? (wordCount ? parseInt(wordCount, 10) : null) : undefined
      }
    });

    if (assignedConsultantId) {
      await prisma.consultation.updateMany({
        where: { leadId: lead.id },
        data: { consultantId: assignedConsultantId }
      }).catch(err => console.warn('[updateLead] Consultation update warning:', err.message));
    }

    const mapped = {
      ...lead,
      name: `${lead.firstName} ${lead.lastName}`,
      serviceId: lead.serviceType,
      assignedConsultantId: lead.assignedToId
    };
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error updating lead', error: error.message });
  }
};

// Find lead by ID — used by public self-fill form to securely retrieve details
async function getPublicLeadDetails(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'Lead ID is required' });
    }
    const lead = await prisma.lead.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        nationality: true,
        preferredLanguage: true,
        serviceType: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingPreferredLanguage: true,
        meetingNotes: true,
        formSubmittedAt: true
      }
    });
    if (!lead) {
      return res.status(404).json({ message: 'No lead found with this ID' });
    }
    // Return only safe fields to the public form
    res.json({
      id: lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      nationality: lead.nationality,
      preferredLanguage: lead.preferredLanguage,
      serviceType: lead.serviceType,
      meetingPreferredDate: lead.meetingPreferredDate,
      meetingPreferredTime: lead.meetingPreferredTime,
      meetingPreferredLanguage: lead.meetingPreferredLanguage,
      meetingNotes: lead.meetingNotes,
      formSubmittedAt: lead.formSubmittedAt
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching lead details', error: error.message });
  }
}

// Update meeting preferences — called when lead submits self-fill form
async function updateMeetingPreference(req, res) {
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      phone,
      nationality,
      preferredLanguage,
      meetingPreferredDate,
      meetingPreferredTime,
      meetingPreferredLanguage,
      meetingNotes,
      qualificationData,
      serviceType,
      serviceId
    } = req.body;

    // Same-Day Booking Restriction
    if (meetingPreferredDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      if (meetingPreferredDate <= todayStr) {
        return res.status(400).json({
          success: false,
          message: 'Booking date must be at least the next calendar day.'
        });
      }
    }

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        firstName,
        lastName,
        phone,
        nationality,
        preferredLanguage,
        meetingPreferredDate,
        meetingPreferredTime,
        meetingPreferredLanguage,
        meetingNotes,
        qualificationData: qualificationData || undefined,
        serviceType: serviceType || serviceId || undefined,
        formSubmittedAt: new Date(),
        status: 'Form Submitted'
      }
    });

    // Auto-create/update consultation — runs in background, does NOT block response
    res.json({
      success: true,
      message: 'Shukriya! Aapki details save ho gayi hain. Hum jald hi aapse contact karenge.',
      lead: {
        id: lead.id,
        firstName: lead.firstName,
        formSubmittedAt: lead.formSubmittedAt
      }
    });

    // 🔔 Trigger In-App Notifications for all staff (same as createLead)
    const { createLeadNotification } = require('./notificationController');
    createLeadNotification({
      leadName: `${lead.firstName} ${lead.lastName}`,
      email: lead.email,
      phone: lead.phone,
      country: lead.countryOfResidence,
      serviceCategory: lead.serviceType,
      appointmentDate: lead.meetingPreferredDate ? `${lead.meetingPreferredDate} ${lead.meetingPreferredTime || ''}` : null,
      reqApp: req.app
    }).catch(err => console.error('[Meeting Pref Notification Error]:', err.message));

    syncLeadConsultation(lead.id, req.app).catch(err => console.error('[BG] syncLeadConsultation failed:', err.message));

  } catch (error) {
    res.status(500).json({ message: 'Server error saving meeting preferences', error: error.message });
  }
}

// Sync Consultation Session and generate/update meeting details and link
async function syncLeadConsultation(leadId, reqApp = null) {
  try {
    console.log(`[BOOKING] Booking submission received for Lead ID: ${leadId}`);
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        serviceType: true,
        meetingPreferredDate: true,
        meetingPreferredTime: true,
        meetingNotes: true,
        formSubmittedAt: true,
        assignedToId: true
      }
    });
    if (!lead || !lead.assignedToId) {
      console.log(`[BOOKING] Lead not found or consultant assignment missing for Lead ID: ${leadId}`);
      return;
    }

    console.log(`[BOOKING] Consultant assigned: ${lead.assignedToId} for Lead: ${lead.firstName} ${lead.lastName}`);

    const isTranslation = (lead.serviceType || '').toLowerCase().includes('translation') || (lead.serviceType || '').toLowerCase().includes('sworn');
    if (isTranslation) {
      return;
    }

    const { getCustomization } = require('./settingsController');
    const settings = getCustomization();
    const duration = settings.flowAutomationSettings?.defaultMeetingDuration || 30;

    let consultation = await prisma.consultation.findFirst({
      where: { leadId: lead.id }
    });

    const fallbackDate = lead.formSubmittedAt ? new Date(lead.formSubmittedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const meetingDate = lead.meetingPreferredDate || fallbackDate;
    const meetingTime = lead.meetingPreferredTime || 'TBD / Flexible';

    // 1. Idempotency Check: Reuse existing Zoom link if already generated
    let meetingLink = consultation?.meetingLink || null;
    let zoomFailed = false;

    if (!meetingLink) {
      console.log(`[ZOOM] Creating meeting for ${lead.firstName} ${lead.lastName} on ${meetingDate} at ${meetingTime}`);
      const zoomService = require('../services/zoomService');
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
            topic: `Eligibility Assessment for ${lead.firstName} ${lead.lastName}`,
            startTime: startTimeISO,
            durationMinutes: Number(duration) || 30
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

      // Fallback: Generate mock/placeholder link if Zoom not configured
      if (!meetingLink && !zoomFailed) {
        console.log('[ZOOM] Zoom service not configured. Generating mock meeting link.');
        meetingLink = 'https://zoom.us/j/' + Math.floor(100000000 + Math.random() * 900000000);
      }
    } else {
      console.log(`[ZOOM] Reusing existing meetingLink for Consultation ID: ${consultation.id}: ${meetingLink}`);
    }

    // Determine Consultation status based on Zoom creation result
    const consultationStatus = (zoomFailed && !meetingLink) ? 'Pending Zoom' : 'Scheduled';

    if (!consultation) {
      consultation = await prisma.consultation.create({
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          durationMinutes: Number(duration),
          status: consultationStatus,
          leadId: lead.id,
          consultantId: lead.assignedToId,
          internalNotes: lead.meetingNotes || '',
          meetingLink: meetingLink
        }
      });
      console.log(`[BOOKING] Created consultation (ID: ${consultation.id}) with status: ${consultationStatus}`);
    } else {
      consultation = await prisma.consultation.update({
        where: { id: consultation.id },
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          status: consultationStatus,
          consultantId: lead.assignedToId,
          internalNotes: lead.meetingNotes || consultation.internalNotes || '',
          meetingLink: meetingLink || consultation.meetingLink
        }
      });
      console.log(`[BOOKING] Updated consultation (ID: ${consultation.id}) with status: ${consultationStatus}`);
    }

    // Clean up any stale duplicate Pending Acceptance cards for this lead
    await prisma.consultation.deleteMany({
      where: {
        leadId: lead.id,
        id: { not: consultation.id },
        status: 'Pending Acceptance'
      }
    }).catch(err => console.warn('[BOOKING] Cleanup duplicate consultation warning:', err.message));

    // Update Lead status to Meeting Scheduled if scheduled
    if (consultationStatus === 'Scheduled') {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { status: 'Meeting Scheduled' }
      }).catch(err => console.error('[BOOKING] Failed to update lead status:', err.message));
      console.log(`[BOOKING] Consultation marked Scheduled for Lead ID: ${lead.id}`);
    }

    // 2. Immediate Idempotent WhatsApp Confirmation for Lead
    if (consultationStatus === 'Scheduled' && meetingLink) {
      try {
        // Idempotency check on WhatsApp notification per consultation
        const existingLog = await prisma.communicationLog.findFirst({
          where: {
            phone: lead.phone,
            channel: 'WHATSAPP',
            externalProviderId: consultation.id
          }
        });

        if (!existingLog) {
          console.log(`[WHATSAPP] Dispatching booking confirmation in background for Lead: ${lead.firstName} ${lead.lastName} (${lead.phone})`);
          
          // Asynchronously dispatch WhatsApp in background so API responds instantly
          (async () => {
            try {
              const { sendCustomWhatsApp } = require('../services/chatbotService');

              const dayjs = require('dayjs');
              const formattedDate = meetingDate ? (meetingDate.includes('-') ? dayjs(meetingDate).format('DD/MM/YYYY') : meetingDate) : meetingDate;

              const frontendUrl = process.env.FRONTEND_URL || 'https://aaa-crm-service.netlify.app';
              const rescheduleUrl = `${frontendUrl}/#/public/lead-form?reschedule=true&consultationId=${consultation.id}`;
              const cancelUrl = `${frontendUrl}/#/public/lead-form?cancel=true&consultationId=${consultation.id}`;
              const packagesUrl = "https://aaabusinessconsultancy.com/services-and-packages/";

              const clientName = `${lead.firstName} ${lead.lastName}`.trim();
              const messageBody = `✈️ *Spain Visa Consultation Confirmed!*

Dear *${clientName}*,

Your Spain Visa Consultation with *AAA Business Consultancy* has been scheduled successfully! 🎉

📅 *Date:* ${formattedDate}
⏰ *Time:* ${meetingTime} (UAE)
🔗 *Meeting Join Link:* ${meetingLink}

─────────────
👇 *Quick Action Links:*
• 🔄 *Reschedule Booking:* ${rescheduleUrl}
• ❌ *Cancel Booking:* ${cancelUrl}
• 📦 *View Visa Packages:* ${packagesUrl}

_Note: Please join within 10 minutes of appointment time to avoid automatic cancellation._`;

              await sendCustomWhatsApp(lead.phone, messageBody).catch(err => console.error('[WHATSAPP Direct Send Error]:', err.message));

              // Log consultation-specific idempotency marker
              await prisma.communicationLog.create({
                data: {
                  phone: lead.phone,
                  name: clientName,
                  channel: 'WHATSAPP',
                  direction: 'OUTBOUND',
                  externalProviderId: consultation.id,
                  deliveryStatus: 'SENT',
                  content: messageBody
                }
              }).catch(err => console.warn('[WHATSAPP Log Warning]:', err.message));

              console.log(`[WHATSAPP] Async confirmation sent for Consultation ID: ${consultation.id}`);
            } catch (asyncErr) {
              console.error('[WHATSAPP Async Dispatch Error]:', asyncErr.message);
            }
          })();
        } else {
          console.log(`[WHATSAPP] Booking confirmation already sent for Consultation ID: ${consultation.id}`);
        }
      } catch (waErr) {
        console.error('[WHATSAPP] Confirmation failed:', waErr.message);
        // Do NOT rollback database status — keep consultation scheduled
      }
    }

    // 3. Immediate Email Confirmation for User (Applicant) and Admin Notification (Runs for every booking)
    try {
      const { sendAppointmentConfirmationEmail, sendEmail } = require('../services/emailService');
      const clientName = `${lead.firstName} ${lead.lastName}`.trim();
      const adminSenderEmail = process.env.RESEND_FROM_EMAIL || process.env.SMTP_USER || 'client@aaabusinessconsultancy.com';
      const mLink = meetingLink || consultation.meetingLink || 'https://zoom.us';
      const mDate = meetingDate || consultation.date || 'TBD';
      const mTime = meetingTime || consultation.timeSlot || 'TBD';

      // Send Confirmation Email to User/Applicant
      if (lead.email) {
        sendAppointmentConfirmationEmail({
          to: lead.email,
          firstName: lead.firstName || 'Client',
          date: mDate,
          timeSlot: mTime,
          meetingLink: mLink,
          consultationId: consultation.id
        })
        .then(() => console.log(`[BOOKING EMAIL] Sent confirmation email to user ${lead.email}`))
        .catch(err => console.error('[BOOKING EMAIL] User email failed:', err.message));
      }

      // Send Booking Notification Email to Admin/Sender
      sendEmail({
        to: adminSenderEmail,
        subject: `🔔 New Assessment Booking Received: ${clientName} (${mDate} at ${mTime})`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
            <h2 style="color: #0f172a;">📅 New Assessment Consultation Booked</h2>
            <p>A new consultation has been booked on the website portal.</p>
            <hr style="border: 1px solid #e2e8f0; margin: 15px 0;" />
            <ul style="line-height: 1.8;">
              <li><b>Client Name:</b> ${clientName}</li>
              <li><b>Email:</b> ${lead.email || 'N/A'}</li>
              <li><b>Phone:</b> ${lead.phone || 'N/A'}</li>
              <li><b>Service Category:</b> ${lead.serviceType || 'Spain Visa / Residency'}</li>
              <li><b>Date:</b> ${mDate}</li>
              <li><b>Time:</b> ${mTime} (UAE)</li>
              <li><b>Zoom Link:</b> <a href="${mLink}">${mLink}</a></li>
            </ul>
            <br/>
            <p><b>AAA Business Consultancy CRM System</b></p>
          </div>
        `
      })
      .then(() => console.log(`[BOOKING EMAIL] Sent notification email to Admin (${adminSenderEmail})`))
      .catch(err => console.error('[BOOKING EMAIL] Admin notification failed:', err.message));

    } catch (emailErr) {
      console.error('[BOOKING EMAIL] Error invoking email dispatch:', emailErr.message);
    }

    // 4. Socket.io Notification to CRM Staff
      try {
        if (reqApp) {
          const io = reqApp.get('io');
          if (io) {
            io.to('role:admin').to('role:consultant').to(`user:${lead.assignedToId}`).emit('new_booking', {
              consultation,
              lead
            });
            console.log(`[SOCKET] new_booking emitted for Consultation ID: ${consultation.id}`);
          }
        }
      } catch (socketErr) {
        console.warn('[SOCKET] Broadcast warning:', socketErr.message);
      }

    return consultation;
  } catch (error) {
    console.error('Error in syncLeadConsultation:', error);
    return null;
  }
}

module.exports = { 
  getLeads, 
  createLead, 
  assignLead, 
  updateLeadStatus, 
  deleteLead,
  getLeadById, 
  updateLead, 
  getPublicLeadDetails, 
  updateMeetingPreference 
};


