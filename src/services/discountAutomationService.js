const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendEmail } = require('./emailService');
const crypto = require('crypto');

async function runDiscountAutomationCheck() {
  console.log('[Discount Automation] Running daily check for Day 5 CEO Discount...');
  try {
    // Find all clients in 'Waiting for Payment' status
    const unpaidClients = await prisma.client.findMany({
      where: {
        status: 'Waiting for Payment',
        createdAt: {
          lte: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago
        }
      },
      include: {
        discountCodes: true
      }
    });

    for (const client of unpaidClients) {
      // If client doesn't already have a CEO discount code
      const hasDiscount = client.discountCodes.some(d => d.code.startsWith('CEO10-'));
      if (!hasDiscount) {
        const uniqueSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
        const code = `CEO10-${uniqueSuffix}`;
        const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

        console.log(`[Discount Automation] Generating Day 5 CEO Discount code ${code} for client ${client.email}`);

        // Create discount code record
        await prisma.discountCode.create({
          data: {
            code,
            discountPercent: 10.0,
            expiryDate,
            clientId: client.id
          }
        });

        // Send email from CEO email
        try {
          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
          const checkoutUrl = `${frontendUrl}/#/portal/documents/${client.id}?code=${code}`;
          
          await sendEmail({
            to: client.email,
            subject: 'Special 24-Hour 10% Discount Offer from the CEO 💳',
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #edf2f7; border-radius: 8px;">
                <h2 style="color: #4f46e5; text-align: center;">AAA Business Consultancy</h2>
                <hr style="border: 0; border-top: 1px solid #edf2f7;" />
                <p>Hello <strong>${client.firstName} ${client.lastName}</strong>,</p>
                <p>I noticed that you haven't completed your relocation package payment yet. I want to make sure you get the best support for your Spain relocation journey.</p>
                <p>As a one-time gesture, I have generated a special <strong>10% discount code</strong> for you, valid for the next 24 hours only:</p>
                
                <div style="background-color: #f7fafc; border-left: 4px solid #4f46e5; padding: 16px; margin: 20px 0; text-align: center; border-radius: 4px;">
                  <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #1a202c;">${code}</span>
                  <p style="font-size: 12px; color: #718096; margin: 8px 0 0;">Valid until: ${expiryDate.toLocaleString()}</p>
                </div>
                
                <p>Please click the button below to complete your payment with the discount applied:</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${checkoutUrl}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Complete Payment</a>
                </div>
                
                <p>If you have any questions or need assistance, feel free to reply to this email.</p>
                <br/>
                <p>Warm regards,</p>
                <p><strong>CEO</strong><br/>AAA Business Consultancy</p>
              </div>
            `
          });
          // Send WhatsApp from CEO / System
          try {
            const { sendCustomWhatsApp } = require('./chatbotService');
            if (client.phone) {
              await sendCustomWhatsApp(client.phone, `🎁 *Special 10% Discount Offer from the CEO*\n\nHello *${client.firstName}*,\n\nWe noticed you haven't completed your relocation package payment. As a special gesture, the CEO has issued a 10% discount code for you:\n\n🎟️ Code: *${code}*\n⏰ Valid for: 48 Hours\n\nClick to complete your payment with discount:\n🔗 ${checkoutUrl}`);
            }
          } catch (waErr) {
            console.error('[Discount Automation] Failed to send WhatsApp discount message:', waErr.message);
          }
          console.log(`[Discount Automation] Successfully sent CEO Discount email and WhatsApp to ${client.email}`);
        } catch (mailError) {
          console.error(`[Discount Automation] Failed to send email to ${client.email}:`, mailError.message);
        }
      }
    }
  } catch (error) {
    console.error('[Discount Automation] Error running discount check:', error.message);
  }
}

function startDiscountScheduler() {
  // Run once on startup
  setTimeout(runDiscountAutomationCheck, 5000);
  
  // Run every 12 hours (43200000 ms)
  setInterval(runDiscountAutomationCheck, 12 * 60 * 60 * 1000);
}

module.exports = {
  runDiscountAutomationCheck,
  startDiscountScheduler
};
