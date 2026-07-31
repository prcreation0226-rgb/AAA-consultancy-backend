const { 
  getActiveCases, 
  getClosedCases, 
  getCyclesByClient, 
  createCycle, 
  updateCycle,
  getCycleChecklist,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  uploadChecklistDoc,
  reviewChecklistDoc,
  resubmitCycle,
  recordGovernmentDecision
} = require('./src/controllers/caseController');

function createMockRes() {
  return {
    statusCode: 200,
    responseData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.responseData = data;
      return this;
    }
  };
}

async function runPhase2IntegrationTests() {
  console.log('===============================================================');
  console.log('STARTING PHASE 2 RESUBMISSION & CHECKLIST INTEGRATION TEST SUITE');
  console.log('===============================================================');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  const prisma = require('./src/config/db');

  // Backup original Prisma methods
  const originalFindUniqueClient = prisma.client.findUnique;
  const originalUpdateClient = prisma.client.update;
  const originalFindFirstCycle = prisma.applicationCycle.findFirst;
  const originalFindUniqueCycle = prisma.applicationCycle.findUnique;
  const originalCreateCycle = prisma.applicationCycle.create;
  const originalUpdateCycle = prisma.applicationCycle.update;
  const originalTransaction = prisma.$transaction;
  const originalFindManyItems = prisma.resubmissionChecklistItem.findMany;
  const originalFindUniqueItem = prisma.resubmissionChecklistItem.findUnique;
  const originalCreateItem = prisma.resubmissionChecklistItem.create;
  const originalUpdateItem = prisma.resubmissionChecklistItem.update;
  const originalDeleteItem = prisma.resubmissionChecklistItem.delete;
  const originalCreateManyItems = prisma.resubmissionChecklistItem.createMany;
  const originalFindFirstDoc = prisma.document.findFirst;
  const originalFindUniqueDoc = prisma.document.findUnique;
  const originalCreateDoc = prisma.document.create;
  const originalUpdateDoc = prisma.document.update;

  try {
    // Shared mock state
    let mockClient = {
      id: 'client-phase2-001',
      clientCode: 'CID-20001',
      firstName: 'Juan',
      lastName: 'Perez',
      visaStatus: 'Visa Refused',
      status: 'Refused',
      assignedToId: 'consultant-001'
    };

    let mockCycles = [];
    let mockChecklistItems = [];
    let mockDocuments = [];

    // Mock Prisma Implementation for Integration Runner
    prisma.client.findUnique = async ({ where }) => (where.id === mockClient.id ? mockClient : null);
    prisma.client.update = async ({ where, data }) => {
      if (data.visaStatus) mockClient.visaStatus = data.visaStatus;
      return mockClient;
    };

    prisma.applicationCycle.findFirst = async ({ where }) => {
      return mockCycles.find(c => c.clientId === where.clientId && where.status.in.includes(c.status)) || null;
    };
    prisma.applicationCycle.findUnique = async ({ where }) => {
      return mockCycles.find(c => c.id === where.id) || null;
    };
    prisma.applicationCycle.create = async ({ data }) => {
      const cycle = { id: `cycle-${Date.now()}`, ...data, createdAt: new Date() };
      mockCycles.push(cycle);
      return cycle;
    };
    prisma.applicationCycle.update = async ({ where, data }) => {
      const idx = mockCycles.findIndex(c => c.id === where.id);
      if (idx !== -1) {
        mockCycles[idx] = { ...mockCycles[idx], ...data };
        return mockCycles[idx];
      }
      return null;
    };

    prisma.$transaction = async (cb) => {
      const tx = {
        applicationCycle: {
          create: prisma.applicationCycle.create
        },
        resubmissionChecklistItem: {
          createMany: async ({ data }) => {
            const created = data.map(item => ({
              id: `item-${Math.random().toString(36).substr(2, 9)}`,
              ...item,
              createdAt: new Date()
            }));
            mockChecklistItems.push(...created);
            return { count: created.length };
          }
        },
        client: {
          update: prisma.client.update
        }
      };
      return await cb(tx);
    };

    prisma.resubmissionChecklistItem.findMany = async ({ where }) => {
      return mockChecklistItems.filter(i => i.applicationId === where.applicationId);
    };
    prisma.resubmissionChecklistItem.findUnique = async ({ where }) => {
      const item = mockChecklistItems.find(i => i.id === where.id);
      if (!item) return null;
      const itemDocs = mockDocuments.filter(d => d.checklistItemId === item.id);
      const cycle = mockCycles.find(c => c.id === item.applicationId);
      return { 
        ...item, 
        documents: itemDocs, 
        applicationCycle: cycle || { clientId: mockClient.id, status: 'Resubmission in Progress' } 
      };
    };
    prisma.resubmissionChecklistItem.create = async ({ data }) => {
      const item = { id: `item-${Date.now()}`, ...data, createdAt: new Date() };
      mockChecklistItems.push(item);
      return item;
    };
    prisma.resubmissionChecklistItem.update = async ({ where, data }) => {
      const idx = mockChecklistItems.findIndex(i => i.id === where.id);
      if (idx !== -1) {
        mockChecklistItems[idx] = { ...mockChecklistItems[idx], ...data };
        return mockChecklistItems[idx];
      }
      return null;
    };
    prisma.resubmissionChecklistItem.delete = async ({ where }) => {
      const idx = mockChecklistItems.findIndex(i => i.id === where.id);
      if (idx !== -1) {
        const removed = mockChecklistItems.splice(idx, 1);
        return removed[0];
      }
      return null;
    };

    prisma.document.findFirst = async ({ where }) => {
      const filtered = mockDocuments.filter(d => d.checklistItemId === where.checklistItemId);
      filtered.sort((a, b) => b.version - a.version);
      return filtered[0] || null;
    };
    prisma.document.findUnique = async ({ where }) => {
      return mockDocuments.find(d => d.id === where.id) || null;
    };
    prisma.document.create = async ({ data }) => {
      const doc = { id: `doc-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`, ...data, uploadedDate: new Date() };
      mockDocuments.push(doc);
      return doc;
    };
    prisma.document.update = async ({ where, data }) => {
      const idx = mockDocuments.findIndex(d => d.id === where.id);
      if (idx !== -1) {
        mockDocuments[idx] = { ...mockDocuments[idx], ...data };
        return mockDocuments[idx];
      }
      return null;
    };

    // TEST 1: Atomic Cycle & Default Checklist Creation
    console.log('\n--- Test 1: Atomic Resubmission Cycle & Default Checklist Generation ---');
    const reqCreate = {
      user: { id: 'consultant-001', role: 'consultant', fullName: 'Carlos Consultant' },
      body: {
        clientId: mockClient.id,
        type: 'resubmission',
        originalSubmissionDate: '2026-05-01',
        refusalDate: '2026-06-15',
        refusalReason: 'Insufficient proof of funds',
        changesMade: 'Added 6-month bank statement with €30,000 balance'
      }
    };
    const resCreate = createMockRes();
    await createCycle(reqCreate, resCreate);

    assert(resCreate.statusCode === 201, 'Cycle created with status HTTP 201');
    assert(mockCycles.length === 1, 'ApplicationCycle record added to database');
    assert(mockCycles[0].status === 'Resubmission in Progress', 'Cycle status initialized to "Resubmission in Progress"');
    assert(mockChecklistItems.length === 5, 'Default 5 checklist items generated automatically in transaction');
    assert(mockClient.visaStatus === 'Resubmission in Progress', 'Client.visaStatus updated to "Resubmission in Progress"');

    const createdCycleId = mockCycles[0].id;

    // TEST 2: Add Custom Checklist Item
    console.log('\n--- Test 2: Add Custom Checklist Item ---');
    const reqAddItem = {
      user: { id: 'consultant-001', role: 'consultant' },
      body: {
        applicationId: createdCycleId,
        title: 'Additional Tax Return 2025',
        category: 'Financial Documents',
        belongsTo: 'Main Applicant',
        isMandatory: true,
        clientInstructions: 'Certified copy from Spanish Tax Agency'
      }
    };
    const resAddItem = createMockRes();
    await addChecklistItem(reqAddItem, resAddItem);

    assert(resAddItem.statusCode === 201, 'Custom checklist item added with status HTTP 201');
    assert(mockChecklistItems.length === 6, 'Checklist total items is now 6');
    assert(resAddItem.responseData.templateKey.startsWith('custom_'), 'Custom item templateKey starts with custom_<uuid>');

    const customItemId = resAddItem.responseData.id;

    // TEST 3: Deletion Rules Enforcement (Rule 2)
    console.log('\n--- Test 3: Checklist Deletion Rules (Rule 2 Enforcement) ---');
    // 3a. Delete item with 0 uploads -> Hard delete
    const reqDelUnused = {
      user: { id: 'consultant-001', role: 'consultant' },
      params: { id: customItemId }
    };
    const resDelUnused = createMockRes();
    await deleteChecklistItem(reqDelUnused, resDelUnused);

    assert(resDelUnused.statusCode === 200 && resDelUnused.responseData.deleted === true, 'Item with zero uploads is hard-deleted from DB when in progress');
    assert(mockChecklistItems.length === 5, 'Checklist item count restored to 5 after hard deletion');

    // TEST 4: Sequential Document Upload & Simple Versioning (Rule 8)
    console.log('\n--- Test 4: Document Upload & Sequential Versioning (Rule 8) ---');
    const firstItemId = mockChecklistItems[0].id; // passport_main
    const reqUploadV1 = {
      user: { id: mockClient.id, role: 'client' },
      params: { id: firstItemId },
      file: { originalname: 'passport_v1.pdf', mimetype: 'application/pdf', size: 1048576, filename: 'passport_v1.pdf' }
    };
    const resUploadV1 = createMockRes();
    await uploadChecklistDoc(reqUploadV1, resUploadV1);

    assert(resUploadV1.statusCode === 201, 'Upload V1 returned HTTP 201');
    assert(resUploadV1.responseData.version === 1, 'Document version set to 1 for first upload');

    const reqUploadV2 = {
      user: { id: mockClient.id, role: 'client' },
      params: { id: firstItemId },
      file: { originalname: 'passport_v2.pdf', mimetype: 'application/pdf', size: 1048576, filename: 'passport_v2.pdf' }
    };
    const resUploadV2 = createMockRes();
    await uploadChecklistDoc(reqUploadV2, resUploadV2);

    assert(resUploadV2.statusCode === 201, 'Upload V2 returned HTTP 201');
    assert(resUploadV2.responseData.version === 2, 'Sequential versioning incremented version counter to 2 (V2)');

    // 3b. Delete item WITH uploads -> Soft delete to NOT_REQUIRED (Rule 2)
    const reqDelUsed = {
      user: { id: 'consultant-001', role: 'consultant' },
      params: { id: firstItemId }
    };
    const resDelUsed = createMockRes();
    await deleteChecklistItem(reqDelUsed, resDelUsed);

    assert(resDelUsed.statusCode === 200 && resDelUsed.responseData.deleted === false && resDelUsed.responseData.status === 'NOT_REQUIRED', 'Item with upload history is soft-deleted as NOT_REQUIRED preserving history');

    // Restore item to MISSING so we can test verification flow
    mockChecklistItems[0].status = 'MISSING';

    // TEST 5: Operations Review & Mandatory Rejection Reason
    console.log('\n--- Test 5: Operations Review & Mandatory Rejection Reason ---');
    const docToReview = mockDocuments[1]; // V2 doc
    const reqRejectNoReason = {
      user: { id: 'ops-001', role: 'operations' },
      params: { documentId: docToReview.id },
      body: { status: 'REJECTED', comment: '' }
    };
    const resRejectNoReason = createMockRes();
    await reviewChecklistDoc(reqRejectNoReason, resRejectNoReason);

    assert(resRejectNoReason.statusCode === 400, 'Rejecting document without comment returns HTTP 400 Bad Request');

    const reqRejectValid = {
      user: { id: 'ops-001', role: 'operations' },
      params: { documentId: docToReview.id },
      body: { status: 'REJECTED', comment: 'Page 2 scan is blurry and cut off' }
    };
    const resRejectValid = createMockRes();
    await reviewChecklistDoc(reqRejectValid, resRejectValid);

    assert(resRejectValid.statusCode === 200 && resRejectValid.responseData.document.status === 'REJECTED', 'Rejecting document with non-empty reason succeeds');

    // TEST 6: Automated Readiness Guard & Transition
    console.log('\n--- Test 6: Verify All Mandatory Items & Automated Readiness Guard ---');
    // Verify all 5 mandatory checklist items
    for (let i = 0; i < mockChecklistItems.length; i++) {
      const item = mockChecklistItems[i];
      const doc = await prisma.document.create({
        data: {
          clientId: mockClient.id,
          applicationId: createdCycleId,
          checklistItemId: item.id,
          version: 1,
          name: `${item.templateKey}_verified.pdf`,
          category: item.category,
          url: `/uploads/${item.templateKey}_verified.pdf`,
          status: 'PENDING_VERIFICATION'
        }
      });
      item.activeDocumentId = doc.id;

      const reqVerify = {
        user: { id: 'ops-001', role: 'operations' },
        params: { documentId: doc.id },
        body: { status: 'VERIFIED' }
      };
      const resVerify = createMockRes();
      await reviewChecklistDoc(reqVerify, resVerify);
    }

    assert(mockCycles[0].status === 'Ready for Resubmission', 'All mandatory items verified -> Cycle auto-transitioned to "Ready for Resubmission"');
    assert(mockClient.visaStatus === 'Ready for Resubmission', 'Client.visaStatus auto-updated to "Ready for Resubmission"');

    // TEST 7: Resubmission Filing
    console.log('\n--- Test 7: Resubmission Filing & Details Recording ---');
    const reqResubmit = {
      user: { id: 'consultant-001', role: 'consultant' },
      params: { id: createdCycleId },
      body: {
        resubmissionDate: '2026-07-31',
        submissionReference: 'EMB-ES-2026-9921',
        changesMade: 'Provided certified 12-month tax statements and new proof of passive rental income.',
        submissionNotes: 'Submitted at Madrid Consulate Desk 4',
        submissionReceiptUrl: 'https://storage.aaa.com/receipts/EMB-ES-2026-9921.pdf'
      }
    };
    const resResubmit = createMockRes();
    await resubmitCycle(reqResubmit, resResubmit);

    assert(resResubmit.statusCode === 200, 'Resubmission filed with HTTP 200 OK');
    assert(resResubmit.responseData.status === 'Resubmitted', 'Cycle status transitioned to "Resubmitted"');
    assert(resResubmit.responseData.submissionReference === 'EMB-ES-2026-9921', 'Submission reference recorded permanently');
    assert(mockClient.visaStatus === 'Resubmitted', 'Client.visaStatus updated to "Resubmitted"');

    // TEST 8: Government Decision Recording (Rule 1 & 7 Enforcement)
    console.log('\n--- Test 8: Record Government Decision (Rule 1 & 7 Enforcement) ---');
    const reqDecision = {
      user: { id: 'consultant-001', role: 'consultant' },
      params: { id: createdCycleId },
      body: {
        governmentDecision: 'Approved',
        governmentDecisionDate: '2026-08-15'
      }
    };
    const resDecision = createMockRes();
    await recordGovernmentDecision(reqDecision, resDecision);

    assert(resDecision.statusCode === 200, 'Government decision recorded with HTTP 200 OK');
    assert(resDecision.responseData.cycle.governmentDecision === 'Approved', 'governmentDecision permanently set to "Approved"');
    assert(resDecision.responseData.cycle.status === 'Resubmitted', 'Cycle status remains "Resubmitted" without extra status strings (Rule 1 Compliance)');
    assert(resDecision.responseData.clientVisaStatus === 'Visa Approved', 'Client.visaStatus permanently set to "Visa Approved"');

    // TEST 9: Phase 1 Appeal Workflow Safeguard Regression
    console.log('\n--- Test 9: Phase 1 Legal Appeal Workflow Safeguard Regression ---');
    mockClient.visaStatus = 'Visa Refused'; // Reset to refused to allow appeal initiation

    const reqAppeal = {
      user: { id: 'consultant-001', role: 'consultant' },
      body: {
        clientId: mockClient.id,
        type: 'appeal',
        lawyerAssigned: 'Abogado Fernando Gomez',
        appealSubmissionDate: '2026-08-20',
        appealDeadline: '2026-09-20'
      }
    };
    const resAppeal = createMockRes();
    await createCycle(reqAppeal, resAppeal);

    assert(resAppeal.statusCode === 201, 'Legal Appeal cycle created with HTTP 201');
    assert(resAppeal.responseData.type === 'appeal', 'Cycle type is "appeal"');
    assert(resAppeal.responseData.lawyerAssigned === 'Abogado Fernando Gomez', 'Lawyer assigned recorded correctly');

  } catch (err) {
    console.error('Integration test failure:', err);
    failed++;
  } finally {
    // Restore original Prisma methods
    prisma.client.findUnique = originalFindUniqueClient;
    prisma.client.update = originalUpdateClient;
    prisma.applicationCycle.findFirst = originalFindFirstCycle;
    prisma.applicationCycle.findUnique = originalFindUniqueCycle;
    prisma.applicationCycle.create = originalCreateCycle;
    prisma.applicationCycle.update = originalUpdateCycle;
    prisma.$transaction = originalTransaction;
    prisma.resubmissionChecklistItem.findMany = originalFindManyItems;
    prisma.resubmissionChecklistItem.findUnique = originalFindUniqueItem;
    prisma.resubmissionChecklistItem.create = originalCreateItem;
    prisma.resubmissionChecklistItem.update = originalUpdateItem;
    prisma.resubmissionChecklistItem.delete = originalDeleteItem;
    prisma.resubmissionChecklistItem.createMany = originalCreateManyItems;
    prisma.document.findFirst = originalFindFirstDoc;
    prisma.document.findUnique = originalFindUniqueDoc;
    prisma.document.create = originalCreateDoc;
    prisma.document.update = originalUpdateDoc;

    console.log('\n===============================================================');
    console.log(`PHASE 2 INTEGRATION TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================');
    process.exit(failed > 0 ? 1 : 0);
  }
}

runPhase2IntegrationTests();
