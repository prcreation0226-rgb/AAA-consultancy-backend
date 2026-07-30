const prisma = require('../config/db');
const { logActivity } = require('../services/auditService');

const getActiveCases = async (req, res) => {
  try {
    const activeCases = await prisma.client.findMany({
      where: {
        OR: [
          { status: { notIn: ['Closed', 'Refused'] } },
          {
            applicationCycles: {
              some: {
                status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
              }
            }
          }
        ]
      },
      include: {
        assignedTo: { select: { fullName: true } },
        applicationCycles: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const mapped = activeCases.map(c => ({
      ...c,
      onboardingDate: c.createdAt,
      name: `${c.firstName} ${c.lastName}`,
      assignedConsultantName: c.assignedTo?.fullName
    }));
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching active cases' });
  }
};

const getClosedCases = async (req, res) => {
  try {
    const closedCases = await prisma.client.findMany({
      where: {
        status: { in: ['Closed', 'Refused'] },
        NOT: {
          applicationCycles: {
            some: {
              status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
            }
          }
        }
      },
      include: {
        assignedTo: { select: { fullName: true } },
        applicationCycles: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const mapped = closedCases.map(c => ({
      ...c,
      onboardingDate: c.createdAt,
      name: `${c.firstName} ${c.lastName}`,
      assignedConsultantName: c.assignedTo?.fullName
    }));
    
    res.json(mapped);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching closed cases' });
  }
};

const getCyclesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userRole = req.user?.role;
    const userId = req.user?.id;

    // Check client ownership for client role
    if (userRole === 'client' && userId !== clientId) {
      return res.status(403).json({ message: 'Access denied. You can only view your own application cycles.' });
    }

    // Check consultant assignment for consultant role
    if (userRole === 'consultant') {
      const clientObj = await prisma.client.findUnique({ where: { id: clientId } });
      if (clientObj && clientObj.assignedToId !== userId) {
        return res.status(403).json({ message: 'Access denied. You can only view application cycles for clients assigned to you.' });
      }
    }

    const cycles = await prisma.applicationCycle.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' }
    });

    // Sanitization per role
    const sanitized = cycles.map(cycle => {
      if (userRole === 'client' || userRole === 'operations' || userRole === 'finance') {
        const { appealDocuments, ...rest } = cycle;
        let sanitizedDocs = null;
        if (appealDocuments && typeof appealDocuments === 'object') {
          const { notes, strategy, internalNotes, ...publicDocs } = appealDocuments;
          sanitizedDocs = publicDocs;
        }
        return {
          ...rest,
          appealDocuments: sanitizedDocs
        };
      }
      return cycle;
    });

    res.json(sanitized);
  } catch (error) {
    console.error('Error in getCyclesByClient:', error);
    res.status(500).json({ message: 'Server error fetching application cycles' });
  }
};

const createCycle = async (req, res) => {
  try {
    const { 
      clientId, 
      type, 
      refusalReason, 
      refusalDate, 
      originalSubmissionDate,
      changesMade,
      lawyerAssigned, 
      appealSubmissionDate,
      appealDeadline, 
      appealDocuments,
      serviceType 
    } = req.body;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required' });
    }

    const userRole = req.user?.role;
    const userId = req.user?.id;

    // 1. Fetch target Client
    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    // 2. Consultant Assignment Safeguard (Guard 1)
    if (userRole === 'consultant' && client.assignedToId !== userId) {
      return res.status(403).json({ message: 'Access denied. You can only initiate application cycles for clients assigned to you.' });
    }

    // 3. Refusal Prerequisite Safeguard (Guard 6)
    const refusedVisaStatuses = ['Refused', 'Visa Refused', 'Rejected', 'Final Refusal'];
    const isClientRefused = refusedVisaStatuses.includes(client.visaStatus) || client.status === 'Refused';
    if (!isClientRefused) {
      return res.status(400).json({ message: 'Invalid transition: A new cycle can only be initiated for refused applications.' });
    }

    // 4. Duplicate Active Cycle Safeguard (Guard 5)
    const activeCycle = await prisma.applicationCycle.findFirst({
      where: {
        clientId,
        status: { in: ['Resubmission in Progress', 'Ready for Resubmission', 'Appeal in Progress'] }
      }
    });

    if (activeCycle) {
      return res.status(409).json({
        message: `Cannot initiate a new cycle. Client already has an active ${activeCycle.type} cycle (${activeCycle.status}).`
      });
    }

    const isAppeal = type === 'appeal';
    const initialStatus = isAppeal ? 'Appeal in Progress' : 'Resubmission in Progress';
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Consultant';

    const cycle = await prisma.applicationCycle.create({
      data: {
        clientId,
        type: type || 'resubmission',
        status: initialStatus,
        serviceType: serviceType || client.serviceType || 'Resubmission / Appeal Package',
        originalSubmissionDate: originalSubmissionDate ? new Date(originalSubmissionDate) : undefined,
        refusalReason: refusalReason || client.refusalReason || 'Visa Refused',
        refusalDate: refusalDate ? new Date(refusalDate) : new Date(),
        changesMade: changesMade || null,
        resubmissionDate: isAppeal ? null : new Date(),
        lawyerAssigned: lawyerAssigned || null,
        appealSubmissionDate: appealSubmissionDate ? new Date(appealSubmissionDate) : (isAppeal ? new Date() : null),
        appealDeadline: appealDeadline ? new Date(appealDeadline) : null,
        appealDocuments: appealDocuments || null
      }
    });

    // Update client.visaStatus ONLY (Preserve client.status unchanged)
    await prisma.client.update({
      where: { id: clientId },
      data: {
        visaStatus: initialStatus
      }
    });

    // Log Activity Timeline
    logActivity({
      clientId,
      actorId: userId || 'staff',
      actorName,
      actorRole: userRole || 'staff',
      action: isAppeal ? 'APPEAL_INITIATED' : 'RESUBMISSION_INITIATED',
      description: isAppeal 
        ? `Legal Appeal initiated by ${actorName}. Lawyer assigned: ${lawyerAssigned || 'TBD'}. Deadline: ${appealDeadline || 'Not set'}.`
        : `Resubmission initiated by ${actorName}. Refusal Reason: "${refusalReason || 'None'}". Changes Required: "${changesMade || 'Document update'}".`
    });

    res.status(201).json(cycle);
  } catch (error) {
    console.error('Error creating application cycle:', error);
    res.status(500).json({ message: 'Server error creating application cycle', error: error.message });
  }
};

const updateCycle = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      lawyerAssigned, 
      refusalReason, 
      changesMade,
      resubmissionDate,
      appealSubmissionDate,
      appealDeadline, 
      appealDocuments,
      governmentDecision,
      governmentDecisionDate
    } = req.body;

    const userRole = req.user?.role;
    const userId = req.user?.id;
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Staff';

    // 1. Fetch existing cycle
    const existingCycle = await prisma.applicationCycle.findUnique({ where: { id } });
    if (!existingCycle) {
      return res.status(404).json({ message: 'Application cycle not found' });
    }

    // 2. Consultant Assignment Safeguard (Guard 1)
    if (userRole === 'consultant') {
      const clientObj = await prisma.client.findUnique({ where: { id: existingCycle.clientId } });
      if (clientObj && clientObj.assignedToId !== userId) {
        return res.status(403).json({ message: 'Access denied. You can only update application cycles for clients assigned to you.' });
      }
    }

    // 3. Strict Transition Sequence Matrix Safeguard (Guard 4)
    if (status && status !== existingCycle.status) {
      const current = existingCycle.status;
      let isValidTransition = false;

      if (current === 'Resubmission in Progress') {
        isValidTransition = status === 'Ready for Resubmission';
      } else if (current === 'Ready for Resubmission') {
        isValidTransition = status === 'Resubmitted';
      } else if (current === 'Appeal in Progress') {
        isValidTransition = status === 'Appeal Approved' || status === 'Appeal Refused';
      }

      if (!isValidTransition) {
        return res.status(400).json({
          message: `Invalid status transition from '${current}' to '${status}'.`
        });
      }
    }

    const cycle = await prisma.applicationCycle.update({
      where: { id },
      data: {
        status: status || undefined,
        lawyerAssigned: lawyerAssigned || undefined,
        refusalReason: refusalReason || undefined,
        changesMade: changesMade || undefined,
        resubmissionDate: resubmissionDate ? new Date(resubmissionDate) : undefined,
        appealSubmissionDate: appealSubmissionDate ? new Date(appealSubmissionDate) : undefined,
        appealDeadline: appealDeadline ? new Date(appealDeadline) : undefined,
        appealDocuments: appealDocuments || undefined,
        governmentDecision: governmentDecision || undefined,
        governmentDecisionDate: governmentDecisionDate ? new Date(governmentDecisionDate) : undefined
      }
    });

    // Update Client Visa Status according to cycle status (Leave client.status untouched)
    let clientVisaStatus = undefined;
    if (status === 'Resubmission in Progress') clientVisaStatus = 'Resubmission in Progress';
    if (status === 'Ready for Resubmission') clientVisaStatus = 'Ready for Resubmission';
    if (status === 'Resubmitted') clientVisaStatus = 'Resubmitted';
    if (status === 'Appeal in Progress') clientVisaStatus = 'Appeal in Progress';
    if (status === 'Appeal Approved' || governmentDecision === 'Approved') clientVisaStatus = 'Visa Approved';
    if (status === 'Appeal Refused' || governmentDecision === 'Refused') clientVisaStatus = 'Final Refusal';

    if (clientVisaStatus) {
      await prisma.client.update({
        where: { id: cycle.clientId },
        data: { visaStatus: clientVisaStatus }
      });
    }

    // Money-Back Guarantee Flagging on Final Refusal (No RefundRequest model created, no payouts)
    if (status === 'Appeal Refused' || governmentDecision === 'Refused') {
      const clientPayments = await prisma.payment.findMany({
        where: { clientId: cycle.clientId }
      });

      const totalPaid = clientPayments.reduce((sum, p) => sum + (p.totalPaid || p.amount || 0), 0);
      const calculatedRefund = Number((totalPaid * 0.50).toFixed(2));

      await prisma.payment.updateMany({
        where: { clientId: cycle.clientId, status: 'Paid' },
        data: {
          refundStatus: 'Refund Eligible',
          refundEligibility: true,
          refundAmount: calculatedRefund,
          refundReason: `Automatic 50% Money-Back Guarantee triggered on Final Refusal (${cycle.serviceType || 'Visa Package'})`
        }
      });

      logActivity({
        clientId: cycle.clientId,
        actorId: 'system',
        actorName: 'System Policy Engine',
        actorRole: 'system',
        action: 'REFUND_ELIGIBILITY_TRIGGERED',
        description: `Final Refusal reached. Client auto-flagged as 'Refund Eligible' for 50% Guarantee (€${calculatedRefund}).`
      });
    }

    // Log Activity Timeline
    logActivity({
      clientId: cycle.clientId,
      actorId: userId || 'staff',
      actorName,
      actorRole: userRole || 'staff',
      action: 'CYCLE_STATUS_UPDATED',
      description: `Case cycle updated to "${status}". Government Decision: ${governmentDecision || 'Pending'}. Updated by ${actorName}.`
    });

    res.json(cycle);
  } catch (error) {
    console.error('Error updating application cycle:', error);
    res.status(500).json({ message: 'Server error updating application cycle', error: error.message });
  }
};

module.exports = {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle
};

