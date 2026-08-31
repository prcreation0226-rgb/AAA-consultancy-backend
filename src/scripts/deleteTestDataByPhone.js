const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanupDataForPhone(targetDigits = '7693091260') {
  console.log(`[Cleanup Script] Searching for all records with phone containing '${targetDigits}'...`);

  try {
    // 1. Find matching Leads
    const leads = await prisma.lead.findMany({
      where: {
        phone: { contains: targetDigits }
      }
    });
    console.log(`Found ${leads.length} matching Lead(s).`);

    // 2. Find matching Clients
    const clients = await prisma.client.findMany({
      where: {
        phone: { contains: targetDigits }
      }
    });
    console.log(`Found ${clients.length} matching Client(s).`);

    const leadIds = leads.map(l => l.id);
    const clientIds = clients.map(c => c.id);

    // 3. Delete Consultations
    const deletedConsultations = await prisma.consultation.deleteMany({
      where: {
        OR: [
          { leadId: { in: leadIds } },
          { clientId: { in: clientIds } },
          { lead: { phone: { contains: targetDigits } } }
        ]
      }
    });
    console.log(`Deleted ${deletedConsultations.count} Consultation(s).`);

    // 4. Delete Payments
    if (clientIds.length > 0) {
      const deletedPayments = await prisma.payment.deleteMany({
        where: { clientId: { in: clientIds } }
      });
      console.log(`Deleted ${deletedPayments.count} Payment(s).`);
    }

    // 5. Delete Documents
    if (clientIds.length > 0) {
      const deletedDocs = await prisma.document.deleteMany({
        where: { clientId: { in: clientIds } }
      });
      console.log(`Deleted ${deletedDocs.count} Document(s).`);
    }

    // 6. Delete ApplicationCycles
    if (clientIds.length > 0) {
      const deletedApps = await prisma.applicationCycle.deleteMany({
        where: { clientId: { in: clientIds } }
      });
      console.log(`Deleted ${deletedApps.count} ApplicationCycle(s).`);
    }

    // 7. Delete CommunicationLogs
    const deletedCommLogs = await prisma.communicationLog.deleteMany({
      where: {
        phone: { contains: targetDigits }
      }
    });
    console.log(`Deleted ${deletedCommLogs.count} CommunicationLog(s).`);

    // 8. Delete AuditLogs
    if (clientIds.length > 0 || leadIds.length > 0) {
      const deletedAuditLogs = await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { clientId: { in: clientIds } },
            { leadId: { in: leadIds } }
          ]
        }
      });
      console.log(`Deleted ${deletedAuditLogs.count} AuditLog(s).`);
    }

    // 9. Delete Notifications
    if (clientIds.length > 0) {
      const deletedNotifs = await prisma.notification.deleteMany({
        where: { clientId: { in: clientIds } }
      });
      console.log(`Deleted ${deletedNotifs.count} Notification(s).`);
    }

    // 10. Delete Clients
    if (clientIds.length > 0) {
      const deletedClients = await prisma.client.deleteMany({
        where: { id: { in: clientIds } }
      });
      console.log(`Deleted ${deletedClients.count} Client(s).`);
    }

    // 11. Delete Leads
    if (leadIds.length > 0) {
      const deletedLeads = await prisma.lead.deleteMany({
        where: { id: { in: leadIds } }
      });
      console.log(`Deleted ${deletedLeads.count} Lead(s).`);
    }

    console.log(`✅ SUCCESS: All data for phone '${targetDigits}' deleted cleanly.`);
  } catch (err) {
    console.error('Error during cleanup:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

cleanupDataForPhone('7693091260');
