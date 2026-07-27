const prisma = require('../config/db');
const { logActivity } = require('../services/auditService');

const getActiveCases = async (req, res) => {
  try {
    const activeCases = await prisma.client.findMany({
      where: {
        status: {
          notIn: ['Closed', 'Refused']
        }
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
        status: {
          in: ['Closed', 'Refused']
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
    const cycles = await prisma.applicationCycle.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(cycles);
  } catch (error) {
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

    const isAppeal = type === 'appeal';
    const status = isAppeal ? 'Appeal in Progress' : 'Resubmission in Progress';
    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Consultant';

    const cycle = await prisma.applicationCycle.create({
      data: {
        clientId,
        type: type || 'resubmission',
        status,
        serviceType: serviceType || 'Resubmission / Appeal Package',
        originalSubmissionDate: originalSubmissionDate ? new Date(originalSubmissionDate) : undefined,
        refusalReason,
        refusalDate: refusalDate ? new Date(refusalDate) : new Date(),
        changesMade: changesMade || null,
        resubmissionDate: isAppeal ? null : new Date(),
        lawyerAssigned: lawyerAssigned || null,
        appealSubmissionDate: appealSubmissionDate ? new Date(appealSubmissionDate) : (isAppeal ? new Date() : null),
        appealDeadline: appealDeadline ? new Date(appealDeadline) : null,
        appealDocuments: appealDocuments || null
      }
    });

    // Update client status & visa status
    await prisma.client.update({
      where: { id: clientId },
      data: {
        visaStatus: isAppeal ? 'Under Legal Appeal' : 'Resubmission in Progress',
        status: 'Refused'
      }
    });

    // Log Activity Timeline
    logActivity({
      clientId,
      actorId: req.user?.id || 'staff',
      actorName,
      actorRole: req.user?.role || 'staff',
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

    const actorName = req.user ? (req.user.fullName || req.user.email) : 'Staff';

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

    // Update Client Visa Status according to cycle status
    let clientVisaStatus = undefined;
    if (status === 'Resubmission in Progress') clientVisaStatus = 'Resubmission in Progress';
    if (status === 'Ready for Resubmission') clientVisaStatus = 'Ready for Resubmission';
    if (status === 'Resubmitted') clientVisaStatus = 'Resubmitted';
    if (status === 'Appeal in Progress') clientVisaStatus = 'Under Legal Appeal';
    if (status === 'Appeal Approved' || governmentDecision === 'Approved') clientVisaStatus = 'Visa Approved';
    if (status === 'Appeal Refused' || governmentDecision === 'Refused') clientVisaStatus = 'Final Refusal';

    if (clientVisaStatus) {
      await prisma.client.update({
        where: { id: cycle.clientId },
        data: { visaStatus: clientVisaStatus }
      });
    }

    // Auto-trigger Refund Eligibility if final refusal occurred
    if (status === 'Appeal Refused' || governmentDecision === 'Refused') {
      const clientPayments = await prisma.payment.findMany({
        where: { clientId: cycle.clientId }
      });

      const totalPaid = clientPayments.reduce((sum, p) => sum + (p.totalPaid || p.amount || 0), 0);
      const calculatedRefund = Number((totalPaid * 0.50).toFixed(2)); // 50% Money-back guarantee

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
      actorId: req.user?.id || 'staff',
      actorName,
      actorRole: req.user?.role || 'staff',
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
