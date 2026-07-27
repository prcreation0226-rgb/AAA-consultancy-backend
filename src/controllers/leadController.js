const prisma = require('../config/db');

const getLeads = async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      include: {
        assignedTo: {
          select: { fullName: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    // Map to frontend expectation
    const mapped = leads.map(l => ({
      ...l,
      createdDate: l.createdAt,
      assignedAt: l.assignedAt || l.createdAt,
      name: `${l.firstName} ${l.lastName}`,
      serviceId: l.serviceType,
      assignedConsultantId: l.assignedToId,
      assignedConsultantName: l.assignedTo?.fullName
    }));
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
    
    // Normalize phone number to check for existing lead (last 10 digits to match with or without country code)
    const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    const matchDigits = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;

    // 1. Check blocked client
    const blockedClient = await prisma.client.findFirst({
      where: {
        isBlocked: true,
        OR: [
          { email: email.toLowerCase() },
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
          { email: email.toLowerCase() },
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
    
    // 3. Check for Duplicate Active Bookings (Status-aware based on Most Recent Lead)
    const latestLead = await prisma.lead.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase() },
          ...(matchDigits ? [{ phone: { contains: matchDigits } }] : [])
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const inactiveStatuses = ['Lost Lead', 'Spam', 'Cold Lead', 'No Show', 'Completed', 'Cancelled', 'Canceled', 'Refused'];
    
    if (latestLead && !inactiveStatuses.includes(latestLead.status)) {
      return res.status(409).json({
        code: 'DUPLICATE_LEAD',
        message: 'You already have an active booking or application under this email/phone.'
      });
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
      // Normal round-robin assignment for non-property leads
      const consultants = await prisma.user.findMany({ where: { role: 'consultant' } });
      assignedToId = consultants.length > 0 ? consultants[0].id : null;
    }

    // Create new lead
    lead = await prisma.lead.create({
        data: {
          firstName,
          lastName,
          email,
          phone,
          source,
          campaignId,
          serviceType: serviceType || serviceId,
          nationality,
          countryOfResidence: countryOfResidence || null,
          preferredLanguage,
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

    // Auto-create consultation — runs in background, does NOT block response
    res.status(201).json(lead);
    syncLeadConsultation(lead.id).catch(err => console.error('[BG] syncLeadConsultation failed:', err.message));
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
      data: { assignedToId: agentId, assignedAt: new Date() }
    });
    await syncLeadConsultation(lead.id);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: 'Server error assigning lead' });
  }
};

const updateLeadStatus = async (req, res) => {
  try {
    const { leadId, status } = req.body;
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { status }
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
    const { id } = req.params;

    // Delete associated consultations first to avoid foreign key constraint violations
    await prisma.consultation.deleteMany({
      where: { leadId: id }
    });

    // Delete the lead
    const lead = await prisma.lead.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Lead deleted successfully', lead });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting lead', error: error.message });
  }
};

const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        assignedTo: {
          select: { fullName: true }
        }
      }
    });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (lead.assignedToId) {
      await syncLeadConsultation(lead.id).catch(err => console.error('[getLeadById] Sync Error:', err.message));
    }

    const mapped = {
      ...lead,
      name: `${lead.firstName} ${lead.lastName}`,
      serviceId: lead.serviceType,
      assignedConsultantId: lead.assignedToId,
      assignedConsultantName: lead.assignedTo?.fullName
    };
    res.json(mapped);
  } catch (error) {
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

    await syncLeadConsultation(lead.id);

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
      where: { id }
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
    syncLeadConsultation(lead.id).catch(err => console.error('[BG] syncLeadConsultation failed:', err.message));
  } catch (error) {
    res.status(500).json({ message: 'Server error saving meeting preferences', error: error.message });
  }
}

// Sync Consultation Session and generate/update meeting details and link
async function syncLeadConsultation(leadId) {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId }
    });
    if (!lead || !lead.assignedToId) {
      return;
    }

    const { getCustomization } = require('./settingsController');
    const settings = getCustomization();
    const duration = settings.flowAutomationSettings?.defaultMeetingDuration || 30;

    let consultation = await prisma.consultation.findFirst({
      where: { leadId: lead.id }
    });

    const consultationStatus = 'Pending Acceptance';
    const fallbackDate = lead.formSubmittedAt ? new Date(lead.formSubmittedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const meetingDate = lead.meetingPreferredDate || fallbackDate;
    const meetingTime = lead.meetingPreferredTime || 'TBD / Flexible';

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
          meetingLink: null  // Generated when agent accepts
        }
      });
      console.log(`Auto-created consultation (ID: ${consultation.id}) for Lead: ${lead.id} — awaiting agent acceptance`);
    } else if (consultation.status === 'Pending Acceptance') {
      // Only update date/time/agent if still pending — don't overwrite an accepted meeting
      consultation = await prisma.consultation.update({
        where: { id: consultation.id },
        data: {
          date: meetingDate,
          timeSlot: meetingTime,
          consultantId: lead.assignedToId,
          internalNotes: lead.meetingNotes || consultation.internalNotes || ''
        }
      });
      console.log(`Updated pending consultation (ID: ${consultation.id}) for Lead: ${lead.id}`);
    }
    // Note: WhatsApp, Email & Reminders are sent ONLY when agent accepts — see respondToConsultation()

  } catch (error) {
    console.error('Error in syncLeadConsultation:', error);
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


