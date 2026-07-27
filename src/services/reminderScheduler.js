const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendEmail } = require('./emailService');
const { sendCustomWhatsApp } = require('./chatbotService');

const startReminderScheduler = () => {
  console.log('[Reminder Scheduler] Starting periodic payment reminders engine...');
  
  // Run check every 30 minutes
  setInterval(async () => {
    try {
      console.log('[Reminder Scheduler] Running check for pending payments...');
      const now = new Date();
      
      // Fetch all clients waiting for payment
      const pendingClients = await prisma.client.findMany({
        where: { status: 'Waiting for Payment' }
      });
      
      for (const client of pendingClients) {
        const timeDiffMs = now.getTime() - new Date(client.createdAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);
        
        // 1. Check 2 Hours Reminder
        if (hoursElapsed >= 2 && hoursElapsed < 24) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '2h' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '2h', 'Reminder: Complete Your Spain Visa Package Payment ✈️', 
              `Please complete your payment within today to initiate your Spain residency processing. Checkout link: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }
        
        // 2. Check 24 Hours Reminder
        if (hoursElapsed >= 24 && hoursElapsed < 48) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '24h' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '24h', 'Action Required: Finish Your Spain Relocation Setup 🇪🇸',
              `It has been 24 hours. Don't lose access to your assigned specialist. Complete payment: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }
        
        // 3. Check 2 Days Reminder
        if (hoursElapsed >= 48 && hoursElapsed < 120) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '2d' }
          });
          if (!sentLog) {
            await sendPaymentReminder(client, '2d', 'Reminder: Confirm Your Application Details & Invoice 🧾',
              `Your invoice is pending payment for 2 days. Final link: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/documents/${client.id}`
            );
          }
        }

        // 4. Check 5 Days CEO Discount Reminder
        if (hoursElapsed >= 120) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: '5d' }
          });
          if (!sentLog) {
            const { runDiscountAutomationCheck } = require('./discountAutomationService');
            await runDiscountAutomationCheck();
            await prisma.reminderLog.create({
              data: { clientId: client.id, type: '5d' }
            });
          }
        }
      }

      // SECTION B: Check 24 Hours Cancellation Reminders
      const cancelledConsultations = await prisma.consultation.findMany({
        where: { status: 'Cancelled' },
        include: { lead: true }
      });

      for (const cons of cancelledConsultations) {
        if (!cons.lead) continue;
        
        // Check if client has already rebooked
        const hasRebooked = await prisma.consultation.findFirst({
          where: {
            leadId: cons.leadId,
            status: { in: ['Scheduled', 'Completed', 'Pending Acceptance'] }
          }
        });
        if (hasRebooked) continue;

        const timeDiffMs = now.getTime() - new Date(cons.updatedAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);

        if (hoursElapsed >= 24) {
          // Check if reminder was already sent
          const sentLog = await prisma.reminderLog.findFirst({
            where: {
              clientId: cons.lead.clientId || cons.leadId,
              type: 'cancelled_rebook_24h'
            }
          });
          if (!sentLog) {
            // Send 24h Cancelled Rebook Reminder
            try {
              // Log first to prevent race condition
              await prisma.reminderLog.create({
                data: {
                  clientId: cons.lead.clientId || cons.leadId,
                  type: 'cancelled_rebook_24h'
                }
              });

              const rebookLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/lead-form?id=${cons.lead.id}&rebook=true`;

              // Send WhatsApp
              if (cons.lead.phone) {
                await sendCustomWhatsApp(cons.lead.phone, `🔔 *Reminder: Rebook your Spain Visa Consultation*\n\nDear ${cons.lead.firstName},\n\nThis is a reminder to rebook your Free Spain Visa Eligibility Assessment. Spots are filling up quickly.\n\nClick the link to book now:\n🔗 ${rebookLink}`);
              }

              // Send Email
              if (cons.lead.email) {
                await sendEmail({
                  to: cons.lead.email,
                  subject: 'Reminder: Rebook Your Spain Visa Consultation - AAA Business Consultancy',
                  html: `
                    <h3>Appointment Reminder</h3>
                    <p>Dear ${cons.lead.firstName},</p>
                    <p>This is a reminder to rebook your Free Spain Visa Eligibility Assessment. Spots are filling up quickly.</p>
                    <p>Please click the link below to select a new date and time:</p>
                    <p><a href="${rebookLink}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Rebook Now</a></p>
                    <p>Thank you!</p>
                  `
                });
              }
              console.log(`[Reminder Scheduler] Sent 24h cancellation rebook reminder to ${cons.lead.email}`);
            } catch (err) {
              console.error('[Reminder Scheduler] Failed to send 24h cancellation reminder:', err.message);
            }
          }
        }
      }

      // SECTION C: Check 48 Hours Additional Documents Reminders
      const pendingDocsClients = await prisma.client.findMany({
        where: { status: 'Additional Documents Required' }
      });

      for (const client of pendingDocsClients) {
        const timeDiffMs = now.getTime() - new Date(client.updatedAt).getTime();
        const hoursElapsed = timeDiffMs / (1000 * 60 * 60);

        if (hoursElapsed >= 48) {
          const sentLog = await prisma.reminderLog.findFirst({
            where: { clientId: client.id, type: 'additional_docs_48h' }
          });
          if (!sentLog) {
            try {
              // Log to DB first
              await prisma.reminderLog.create({
                data: { clientId: client.id, type: 'additional_docs_48h' }
              });

              const portalUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/portal/login`;
              const clientName = `${client.firstName} ${client.lastName}`;

              // Send Email
              if (client.email) {
                await sendEmail({
                  to: client.email,
                  subject: 'Reminder: Pending Additional Documents for Spain Visa 🇪🇸',
                  html: `
                    <h3>Document Upload Reminder</h3>
                    <p>Dear ${client.firstName},</p>
                    <p>This is a reminder that we are still waiting for the additional documents requested for your Spain Visa / Relocation application.</p>
                    <p>Please log in to your portal and upload the files to avoid delays in your submission process:</p>
                    <p><a href="${portalUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Upload Portal Login</a></p>
                    <p>Best regards,<br/>AAA Business Consultancy Team</p>
                  `
                });
              }

              // Send WhatsApp
              if (client.phone) {
                await sendCustomWhatsApp(client.phone, `🔔 *Reminder: Pending Additional Documents Required*\n\nHello *${clientName}*,\n\nWe haven't received your requested additional documents yet. Please upload them here:\n\n🔗 ${portalUrl}`);
              }
              console.log(`[Reminder Scheduler] Sent additional docs reminder to ${client.email}`);
            } catch (err) {
              console.error('[Reminder Scheduler] Failed to send additional docs reminder:', err.message);
            }
          }
        }
      }
    } catch (error) {
      console.error('[Reminder Scheduler] Error running reminders cron:', error);
    }
  }, 1000 * 60 * 30); // 30 minutes
};

async function sendPaymentReminder(client, type, subject, messageBody) {
  try {
    console.log(`[Reminder Scheduler] Sending ${type} payment reminder to client ${client.email}`);
    
    // Log to DB first to avoid double triggers in case of async delay
    await prisma.reminderLog.create({
      data: { clientId: client.id, type }
    });
    
    // Send email
    if (client.email) {
      await sendEmail({
        to: client.email,
        subject,
        html: `
          <h3>Hello ${client.firstName},</h3>
          <p>${messageBody}</p>
          <p>Best regards,<br/>AAA Business Consultancy Team</p>
        `
      });
    }
    
    // Send WhatsApp
    if (client.phone) {
      await sendCustomWhatsApp(client.phone, `🔔 *${subject}*\n\nDear ${client.firstName},\n\n${messageBody}`);
    }
  } catch (err) {
    console.error(`Failed to send ${type} reminder:`, err.message);
  }
}

module.exports = { startReminderScheduler };
