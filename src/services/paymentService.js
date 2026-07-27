const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { paymentDripQueue } = require('../queues/queueSetup');

// Secure Payment State Machine Transition
const processPaymentEvent = async (event) => {
  try {
    const session = event.data.object;
    // Assuming we pass paymentId in client_reference_id or metadata
    const paymentId = session.client_reference_id || session.metadata?.paymentId;
    const transactionId = session.id;

    if (!paymentId) {
      console.warn('Payment Event received without paymentId reference', event.id);
      return;
    }

    // Use Prisma transaction for atomicity and idempotency check
    await prisma.$transaction(async (tx) => {
      // Find the payment record
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { client: true, applicationCycle: true }
      });

      if (!payment) {
        throw new Error(`Payment record ${paymentId} not found`);
      }

      // Idempotency: Ignore if this transactionId has already been successfully processed
      if (payment.transactionId === transactionId && payment.status === 'Paid') {
        console.log(`Payment event ${event.id} already processed. Skipping.`);
        return;
      }

      // Define state transition logic
      if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
        // Enforce deterministic transition rules (Only Pending -> Paid)
        if (payment.status !== 'Pending') {
          throw new Error(`Invalid state transition: Cannot transition from ${payment.status} to Paid`);
        }

        const totalPaid = session.amount_total ? session.amount_total / 100 : payment.amount;

        const clientWithAgent = await tx.client.findUnique({
          where: { id: payment.clientId },
          include: { assignedTo: true }
        });
        const snapshotRate = (clientWithAgent && clientWithAgent.assignedTo) 
          ? (clientWithAgent.assignedTo.commissionRate || 0) 
          : 0;

        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: 'Paid',
            transactionId: transactionId,
            paymentMethod: 'Stripe',
            totalPaid: totalPaid,
            commissionRate: snapshotRate
          }
        });

        // Trigger cascade state changes: If application exists, move to Active State
        if (payment.applicationId) {
          await tx.applicationCycle.update({
            where: { id: payment.applicationId },
            data: { status: 'Payment Received - Pending Docs' }
          });

          // Immutable Audit Log
          await tx.auditLog.create({
            data: {
              applicationId: payment.applicationId,
              actorId: 'System-StripeWebhook',
              action: 'PAYMENT_RECEIVED',
              newState: { status: 'Payment Received - Pending Docs' }
            }
          });
        }

        // Also update Client status and package details
        if (payment.client) {
          const isTranslation = (payment.client.serviceType || '').includes('Translation') || (payment.client.serviceId || '').includes('translation');
          const packageId = session.metadata?.packageId;
          const isNoShowAssessment = session.metadata?.type === 'no_show_case_assessment' || packageId === 'option_a' || packageId === 'Option A';

          const updatedClient = await tx.client.update({
            where: { id: payment.clientId },
            data: {
              documentUploadAllowed: !isNoShowAssessment, // Keep locked if it's only €250 case assessment
              packageId: packageId || undefined,
              status: isNoShowAssessment 
                ? 'Partially Paid' 
                : (isTranslation ? 'Documents Under Review' : 'Payment Received'),
              visaStatus: isNoShowAssessment
                ? 'Not Started'
                : (isTranslation ? 'Not Started' : 'Document Preparation')
            }
          });

          // Send Checklist Email only if they paid for full package
          if (!isNoShowAssessment) {
            try {
              const { sendVisaChecklist } = require('./emailService');
              await sendVisaChecklist(updatedClient.email, `${updatedClient.firstName} ${updatedClient.lastName}`, updatedClient.serviceType);
              console.log(`[Auto-Checklist Webhook] Sent checklist to client ${updatedClient.email} for ${updatedClient.serviceType}`);
            } catch (emailErr) {
              console.error('[Auto-Checklist Webhook] Failed to send checklist email:', emailErr.message);
            }
          }

          // Send Automated Payment Receipt & Credentials WhatsApp Message
          try {
            const { sendPaymentSuccessWhatsApp } = require('./whatsappService');
            await sendPaymentSuccessWhatsApp({
              client: updatedClient,
              paymentId: payment.id,
              amount: totalPaid,
              serviceType: updatedClient.serviceType,
              generatedPassword: session.metadata?.tempPassword || null
            });
            console.log(`[Auto-WhatsApp Payment Webhook] Sent payment success & portal credentials to client ${updatedClient.phone}`);
          } catch (waErr) {
            console.error('[Auto-WhatsApp Payment Webhook] Failed to send WhatsApp notification:', waErr.message);
          }
        }
        
        // Remove from payment drip queue if applicable (handled by queue removal logic usually)
        
      } else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
        // We do not change state from Pending, but we might enqueue a payment drip reminder
        await paymentDripQueue.add('payment-failed-reminder', {
          clientId: payment.clientId,
          paymentId: payment.id,
          amount: payment.amount
        });
      }
    });

  } catch (err) {
    console.error('Failed to process payment event:', err);
    throw err; // Allow BullMQ or caller to handle retry/dlq
  }
};

module.exports = {
  processPaymentEvent,
  createNoShowCheckoutSession: async (clientId) => {
    const client = await prisma.client.findUnique({
      where: { id: clientId }
    });

    if (!client) throw new Error(`Client ${clientId} not found`);

    // Create database payment entry
    const payment = await prisma.payment.create({
      data: {
        clientId: client.id,
        amount: 262.50, // €250 + 5% VAT
        status: 'Pending',
        paymentMethod: 'Stripe',
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      }
    });

    const stripeSecret = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
    const stripe = require('stripe')(stripeSecret);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Professional Case Assessment',
            description: 'Includes One-to-One Case Review & Eligibility Evaluation. Deductible within 14 days. (5% VAT Included)',
          },
          unit_amount: 26250, // €262.50 in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      consent_collection: {
        terms_of_service: 'required',
      },
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/#/public/booking`,
      metadata: {
        clientId: client.id,
        paymentId: payment.id,
        type: 'no_show_case_assessment'
      }
    });

    // Update payment gateway ID
    await prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayId: session.id }
    });

    return session.url;
  },

  checkAndApplyDeduction: async (clientId, basePrice) => {
    // Find any paid case assessment payment in the last 14 days
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const paidAssessment = await prisma.payment.findFirst({
      where: {
        clientId: clientId,
        status: 'Paid',
        amount: 262.50, // The €250 + 5% VAT payment
        createdAt: {
          gte: fourteenDaysAgo
        }
      }
    });

    if (paidAssessment) {
      // Deduct €250 from basePrice
      const finalPrice = Math.max(0, basePrice - 250);
      return {
        deducted: true,
        price: finalPrice,
        creditApplied: 250
      };
    }

    return {
      deducted: false,
      price: basePrice,
      creditApplied: 0
    };
  }
};
