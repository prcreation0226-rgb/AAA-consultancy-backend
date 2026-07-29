const twilio = require('twilio');
const prisma = require('../config/db');
const { connection: redis } = require('../queues/connection');
const axios = require('axios');

const SESSION_TIMEOUT = 3600; // 1 hour session validity

function isWhitelistedPhone(phone) {
  // Enable phone whitelist restriction ONLY if TEST_MODE or TESTING_MODE is explicitly set to 'true'
  if (process.env.TESTING_MODE !== 'true' && process.env.TEST_MODE !== 'true') {
    return true;
  }

  const envNumbers = (process.env.ALLOWED_TEST_NUMBERS || process.env.TEST_PHONES || '').split(',');
  const defaultTestNumbers = ['+918770145658', '+917693091260', '+917047687998', '+971524350123', '+971524360123', '+971566952566'];

  const allAllowed = [...envNumbers, ...defaultTestNumbers]
    .map(n => n.trim().replace(/[^\d]/g, ''))
    .filter(Boolean);

  const incomingDigits = (phone || '').replace(/[^\d]/g, '');
  if (!incomingDigits) return false;

  return allAllowed.some(allowed => incomingDigits.endsWith(allowed) || allowed.endsWith(incomingDigits));
}

/**
 * Handles incoming client WhatsApp messages, parses their intent, and sends chatbot replies.
 * 
 * @param {string} phone - Inbound sender phone number
 * @param {string} name - Inbound sender name
 * @param {string} text - Message text content
 */
exports.handleChatbotMessage = async (phone, name, text, messageId = null, mediaUrl = null) => {
  // Normalize phone format
  let cleanPhone = phone.trim();
  if (cleanPhone.startsWith('whatsapp:')) {
    cleanPhone = cleanPhone.substring(9);
  }
  cleanPhone = cleanPhone.replace(/[^\d+]/g, ''); // Keep only digits and '+'
  if (!cleanPhone.startsWith('+')) {
    cleanPhone = '+' + cleanPhone;
  }

  // Format message text with mediaUrl if present
  const displayContent = `${text || ''}${mediaUrl ? `\n[FILE: ${mediaUrl}]` : ''}`.trim();

  // Log incoming message to Database
  await logCommunication(cleanPhone, displayContent, "INBOUND", name, messageId);

  // 0. TESTING MODE WHITELIST CHECK
  if (!isWhitelistedPhone(cleanPhone)) {
    console.log(`[TESTING MODE] Ignoring auto-reply for non-whitelisted number: ${cleanPhone}`);
    return; // Stop chatbot from responding
  }

  // 1. Check if Live Agent Mode is active for this user
  const agentModeKey = `chatbot:agent_mode:${cleanPhone}`;
  const isAgentMode = await redis.get(agentModeKey);
  
  const cleanMessage = text.trim().toLowerCase();

  // 1b. Validate English-only message requirements & send deduplicated auto-reply
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const foreignWords = ['hola', 'bonjour', 'marhaban', 'ciao', 'hallo', 'como', 'estás', 'gracias', 'merci', 'shukran'];
  const words = cleanMessage.split(/\s+/);
  const hasForeignWord = words.some(w => foreignWords.includes(w));
  if (hasNonAscii || hasForeignWord) {
    const nonEnglishDedupeKey = `chatbot:non_english_warn:${cleanPhone}`;
    const alreadyWarned = await redis.get(nonEnglishDedupeKey);
    if (!alreadyWarned) {
      if (redis.set) {
        await redis.set(nonEnglishDedupeKey, 'true', 'EX', 1800);
      }
      await sendCustomWhatsApp(
        cleanPhone,
        "Thank you for contacting us. Our customer support team only speaks English. Kindly send your message in English, and we will be happy to assist you."
      );
    }
    return;
  }

  const isResumeCommand = (cleanMessage === 'menu' || cleanMessage === 'help' || cleanMessage === 'start');
  if (isResumeCommand) {
    if (isAgentMode === 'true') {
      await redis.del(agentModeKey);
      console.log(`Chatbot: Agent mode disabled for ${cleanPhone} by menu reset command.`);
    }
  }

  // If agent mode is active, completely skip responding (allows human conversation)
  if (isAgentMode === 'true') {
    console.log(`Chatbot: Agent mode is active for ${cleanPhone}. Skipping chatbot auto-response.`);
    return;
  }

  // Retrieve user session stage
  const sessionKey = `chatbot:session:${cleanPhone}`;
  const userSessionRaw = await redis.get(sessionKey);
  let userSession = userSessionRaw ? JSON.parse(userSessionRaw) : { stage: 'INIT' };

  // Detect and track traffic source from incoming message text
  let detectedSource = userSession.source || 'WhatsApp';
  if (cleanMessage.includes('tiktok')) {
    detectedSource = 'TikTok Ads';
  } else if (cleanMessage.includes('instagram')) {
    detectedSource = 'Instagram Ads';
  } else if (cleanMessage.includes('facebook')) {
    detectedSource = 'Facebook Ads';
  }
  userSession.source = detectedSource;

  // 2. Handoff to Live Agent command
  if (cleanMessage === 'agent' || cleanMessage === 'talk to agent') {
    await redis.set(agentModeKey, 'true', 'EX', 86400); // Pause bot for 24 hours
    await redis.del(sessionKey); // Clear temporary menu session
    
    await sendCustomWhatsApp(cleanPhone, "👤 *Live Agent Mode Activated!*\n\nOur consultants have been notified and will message you shortly. The automated assistant is now paused.\n\n_To resume the chatbot at any time, just reply *'menu'*._");
    console.log(`[AGENT HANDOFF] Live agent requested by ${cleanPhone} (${name}). Chatbot paused.`);
    
    await logCommunication(cleanPhone, `User requested Live Agent support. Chatbot paused for 24 hours.`, "SYSTEM");
    return;
  }  // Check if Lead form has been submitted (Lead record exists in Database)
  let lead = null;
  try {
    const rawDigits = cleanPhone.replace(/[^\d]/g, '');
    const matchDigits = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
    if (matchDigits) {
      lead = await prisma.lead.findFirst({
        where: { phone: { contains: matchDigits } }
      });
    }
  } catch (dbError) {
    console.warn("[CHATBOT] Error checking existing lead:", dbError.message);
  }

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const bookingLink = `${frontendUrl}/#/public/lead-form?source=${encodeURIComponent(detectedSource)}&phone=${encodeURIComponent(cleanPhone)}`;

  // 3. IF FORM HAS NOT BEEN SUBMITTED YET (No Lead in DB):
  if (!lead) {
    if (userSession.stage === 'INIT' || isResumeCommand) {
      // 3a. First Message: Send Greeting + Form Link
      const greetingMsg = `Greetings from *AAA Business Consultancy LLC*. Thank you for contacting us regarding Spain Visa & Residency Services.✈️✈️`;
      const instructionMsg = `To book your Free 20-Minute Eligibility Assessment & Verification, please click the link below to select your preferred date and time:\n\n${bookingLink}`;

      await sendCustomWhatsApp(cleanPhone, greetingMsg);
      await new Promise(resolve => setTimeout(resolve, 500));
      await sendCustomWhatsApp(cleanPhone, instructionMsg);

      userSession.stage = 'BOOKING_LINK_SENT';
      userSession.reminderSent = false;
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      return;
    } else {
      // 3b. Second Message: Send Dedicated Professional Reminder EXACTLY ONCE
      if (!userSession.reminderSent) {
        const reminderMsg = `📋 *Eligibility Assessment Required*\n\nDear Client, to help our team review your profile and assist you further, kindly complete your initial assessment form first:\n\n👉 ${bookingLink}\n\n_Once submitted, our dedicated consultant will immediately reach out to you._`;
        await sendCustomWhatsApp(cleanPhone, reminderMsg);

        userSession.reminderSent = true;
        await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
        return;
      } else {
        // 3c. Third & Subsequent Messages: STAY SILENT (No auto-reply until form is submitted)
        console.log(`[CHATBOT] Reminder already sent to ${cleanPhone}. Staying silent until form is submitted.`);
        return;
      }
    }
  }

  // 4. IF FORM HAS BEEN SUBMITTED (Lead exists in DB):
  if (userSession.stage === 'INIT' || isResumeCommand) {
    const greetingMsg = `Hello! Welcome back to *AAA Business Consultancy LLC*. Our team has received your details and will assist you shortly.`;
    await sendCustomWhatsApp(cleanPhone, greetingMsg);
    userSession.stage = 'BOOKING_LINK_SENT';
    await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
    return;
  }

  if (userSession.stage === 'BOOKING_LINK_SENT') {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (OPENAI_API_KEY && OPENAI_API_KEY !== 'your_openai_api_key_here') {
      try {
        const aiAnswer = await getOpenAIAnswer(text);
        await sendCustomWhatsApp(cleanPhone, aiAnswer);
        return;
      } catch (e) {
        console.error("OpenAI chatbot failure:", e.message);
      }
    } else if (GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here') {
      try {
        const aiAnswer = await getGeminiAnswer(text);
        await sendCustomWhatsApp(cleanPhone, aiAnswer);
        return;
      } catch (e) {
        console.error("Gemini chatbot failure:", e.message);
      }
    }

    console.log(`[CHATBOT] Chatbot link already sent to ${cleanPhone}. Ready for human agent reply.`);
  }
};

/**
 * Sends free-text responses via Twilio WhatsApp API or logs in Dry-Run mode.
 */
async function sendCustomWhatsApp(phone, messageBody) {
  let cleanPhone = phone.trim();
  if (cleanPhone.startsWith('whatsapp:')) {
    cleanPhone = cleanPhone.substring(9);
  }
  cleanPhone = cleanPhone.replace(/[^\d+]/g, '');
  if (!cleanPhone.startsWith('+')) {
    cleanPhone = '+' + cleanPhone;
  }

  // Sandbox Mode Whitelist Filter
  if (!isWhitelistedPhone(cleanPhone)) {
    console.log(`[TEST MODE] Blocked automated outbound WhatsApp message to ${cleanPhone} (not whitelisted)`);
    return; // Drop the message completely
  }

  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

  const isConfigured = !!(
    TWILIO_ACCOUNT_SID && 
    TWILIO_ACCOUNT_SID.startsWith('AC') && 
    TWILIO_AUTH_TOKEN && 
    TWILIO_AUTH_TOKEN !== 'your_twilio_auth_token_here' && 
    TWILIO_WHATSAPP_FROM
  );

  const twilioTo = `whatsapp:${cleanPhone}`;

  if (isConfigured) {
    try {
      const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      await client.messages.create({
        body: messageBody,
        from: TWILIO_WHATSAPP_FROM,
        to: twilioTo
      });
    } catch (err) {
      console.error(`Twilio Chatbot Outbound Send failed to ${twilioTo}:`, err.message);
    }
  } else {
    console.log('------------------------------------------------------------');
    console.log(`[CHATBOT DRY-RUN SEND]`);
    console.log(`To:       ${twilioTo}`);
    console.log(`Body:     ${messageBody}`);
    console.log('------------------------------------------------------------');
  }

  // Log to database communications log
  await logCommunication(phone, messageBody, "OUTBOUND");
}

/**
 * Creates a record in CommunicationLog linked to the matching client.
 */
async function logCommunication(phone, messageText, direction, name = 'Applicant', messageId = null) {
  try {
    let cleanPhone = phone.trim();
    if (cleanPhone.startsWith('whatsapp:')) {
      cleanPhone = cleanPhone.substring(9);
    }
    cleanPhone = cleanPhone.replace(/[^\d+]/g, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+' + cleanPhone;
    }
    const numberPart = cleanPhone.replace('+', '');

    const client = await prisma.client.findFirst({
      where: { phone: { contains: numberPart } }
    });

    await prisma.communicationLog.create({
      data: {
        clientId: client ? client.id : null,
        phone: cleanPhone,
        name: name,
        channel: 'WHATSAPP',
        direction: direction,
        content: messageText,
        messageId: messageId,
        deliveryStatus: 'SENT'
      }
    });
  } catch (e) {
    console.warn("Could not log chatbot message to Database:", e.message);
  }
}

/**
 * Queries OpenAI completions API for general visa enquiries.
 */
async function getOpenAIAnswer(userQuery) {
  const apiKey = process.env.OPENAI_API_KEY;
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful customer support chatbot for AAA Business Consultancy. We help clients obtain visas, residencies (like Digital Nomad Visa, Non-Lucrative Visa, Golden Visa), and Sworn Translations in Spain. Answer briefly, professionally, and keep it under 3 sentences. Mention that the user can reply "agent" to talk to a human consultant.'
        },
        { role: 'user', content: userQuery }
      ],
      max_tokens: 150
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content.trim();
}

/**
 * Queries Google Gemini API for general visa enquiries.
 */
async function getGeminiAnswer(userQuery) {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      contents: [
        {
          parts: [
            {
              text: `You are a helpful customer support chatbot for AAA Business Consultancy. We help clients obtain visas, residencies (like Digital Nomad Visa, Non-Lucrative Visa, Golden Visa), and Sworn Translations in Spain. Answer briefly, professionally, and keep it under 3 sentences. Mention that the user can reply "agent" to talk to a human consultant. User Question: ${userQuery}`
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 150
      }
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.candidates[0].content.parts[0].text.trim();
}

exports.sendCustomWhatsApp = sendCustomWhatsApp;
