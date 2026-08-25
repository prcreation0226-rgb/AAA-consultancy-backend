const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function syncUniversalClientCodes() {
  console.log("=== STARTING UNIVERSAL CLIENT CODE UNIFICATION ===");
  try {
    // Step 1: Fetch all Leads in order of creation to determine their exact Lead index
    const allLeads = await prisma.lead.findMany({
      select: { id: true, email: true, phone: true, createdAt: true, clientId: true },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`Found ${allLeads.length} total Leads in database.`);

    // Map lead ID & email & phone to its exact sequential CID code
    const leadCodeMap = new Map();
    allLeads.forEach((lead, index) => {
      const code = `CID-${12001 + index}`;
      leadCodeMap.set(lead.id, code);
      if (lead.email) leadCodeMap.set(lead.email.toLowerCase().trim(), code);
      if (lead.phone) leadCodeMap.set(lead.phone.trim(), code);
      if (lead.clientId) leadCodeMap.set(lead.clientId, code);
    });

    // Step 2: Unify Client records with their matching Lead's sequential code
    const allClients = await prisma.client.findMany({
      include: { lead: true }
    });

    console.log(`\nFound ${allClients.length} total Clients in database.`);

    let fallbackCounter = 12001 + allLeads.length;

    for (const client of allClients) {
      let matchingCode = null;
      if (client.leadId && leadCodeMap.has(client.leadId)) {
        matchingCode = leadCodeMap.get(client.leadId);
      } else if (client.email && leadCodeMap.has(client.email.toLowerCase().trim())) {
        matchingCode = leadCodeMap.get(client.email.toLowerCase().trim());
      } else if (client.phone && leadCodeMap.has(client.phone.trim())) {
        matchingCode = leadCodeMap.get(client.phone.trim());
      } else if (leadCodeMap.has(client.id)) {
        matchingCode = leadCodeMap.get(client.id);
      }

      if (!matchingCode) {
        matchingCode = `CID-${fallbackCounter++}`;
      }

      console.log(`[Client Sync] Setting Client ${client.firstName} ${client.lastName} (${client.email}) -> Universal Code: ${matchingCode}`);

      await prisma.client.update({
        where: { id: client.id },
        data: { clientCode: matchingCode }
      }).catch(err => console.warn(`Could not update client ${client.id}:`, err.message));
    }

    console.log("\n✅ UNIVERSAL CLIENT CODE UNIFICATION COMPLETE!");

    const ramClient = await prisma.client.findFirst({
      where: { email: 'sanjukiaan@gmail.com' }
    });
    const ramLead = await prisma.lead.findFirst({
      where: { email: 'sanjukiaan@gmail.com' }
    });

    console.log(`\n--- VERIFICATION RESULT FOR 'ram check' ---`);
    console.log(`Client Name: ${ramClient?.firstName} ${ramClient?.lastName}`);
    console.log(`Client clientCode: ${ramClient?.clientCode}`);

  } catch (err) {
    console.error("Migration error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

syncUniversalClientCodes();
