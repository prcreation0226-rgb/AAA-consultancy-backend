const twilio = require('twilio');
const prisma = require('../config/db');
const { connection: redis } = require('../queues/connection');
const axios = require('axios');

const SESSION_TIMEOUT = 3600; // 1 hour session validity

function isWhitelistedPhone(phone) {
  // If TESTING_MODE is explicitly set to 'false', chatbot is in PRODUCTION MODE (responds to everyone)
  if (process.env.TESTING_MODE === 'false' || process.env.TEST_MODE === 'false') {
    return true;
  }

  // By default (or when TESTING_MODE=true), Sandbox/Testing mode is ACTIVE
  const envNumbers = (process.env.ALLOWED_TEST_NUMBERS || process.env.TEST_PHONES || '').split(',');
  const defaultTestNumbers = ['+917693091260', '+917047687998', '+971524350123', '+971524360123', '+971566952566'];

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
  }

  // 3. State-based Flow Transitions
  if (userSession.stage === 'INIT' || isResumeCommand) {
    let lead = null;
    try {
      const numberPart = cleanPhone.replace('+', '');
      lead = await prisma.lead.findFirst({
        where: { phone: { contains: numberPart } }
      });
      if (lead) {
        console.log(`[CHATBOT] Found existing lead ${lead.id} for phone ${cleanPhone}`);
      }
    } catch (dbError) {
      console.warn("[CHATBOT] Error checking existing lead:", dbError.message);
    }

    const greetingMsg = `Greetings from *AAA Business Consultancy LLC*. Thank you for contacting us regarding Spain Visa & Residency Services.✈️✈️`;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const bookingLink = `${frontendUrl}/#/public/lead-form?source=${encodeURIComponent(detectedSource)}&phone=${encodeURIComponent(cleanPhone)}`;
    const instructionMsg = `To book your Free 20-Minute Eligibility Assessment & Verification, please click the link below to select your preferred date and time:\n\n${bookingLink}`;

    await sendCustomWhatsApp(cleanPhone, greetingMsg);
    await new Promise(resolve => setTimeout(resolve, 500));
    await sendCustomWhatsApp(cleanPhone, instructionMsg);

    userSession.stage = 'BOOKING_LINK_SENT';
    userSession.leadId = lead ? lead.id : null;
    await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
    return;
  }

  if (userSession.stage === 'AWAITING_MAIN_MENU') {
    const choice = cleanMessage.trim();
    if (choice === '1' || choice === '2') {
      userSession.stage = 'AWAITING_VISA_SELECTION';
      userSession.category = choice === '1' ? 'Visa' : 'Assessment';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      
      const visaMenu = `Please select your target Spain Visa program (1-5):\n\n1️⃣ Digital Nomad Residency (DNV)\n2️⃣ Non Lucrative Residency (NLV)\n3️⃣ Study Visa (Language, Vocational Training, Bachelor & Master)\n4️⃣ Spain Tourist Visa (Schengen)\n5️⃣ Self Employed / Business Residency`;
      await sendCustomWhatsApp(cleanPhone, visaMenu);
      return;
    } else if (choice === '3') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const bookingLink = `${frontendUrl}/#/public/lead-form?source=${encodeURIComponent(detectedSource)}&id=${userSession.leadId || ''}&service=property`;
      const msg = `Click the link below to select a date and time for your Free Property Consultation:\n\n🔗 ${bookingLink}`;
      await sendCustomWhatsApp(cleanPhone, msg);
      
      userSession.stage = 'BOOKING_LINK_SENT';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      return;
    } else if (choice === '4') {
      userSession.stage = 'AWAITING_TRANSLATION_CONFIRM';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      
      const rateMsg = `📄 *Spanish Sworn Translation Rates* (excluding 5% VAT):\n\n🇬🇧 English to Spanish: €0.15 Per Word\n🇸🇦 Arabic to Spanish: €0.25 Per Word\n🇵🇰 Urdu to Spanish: €0.40 Per Word\n\n*Would you like to proceed with your translation estimate?* Reply *'YES'* to get your document upload link.`;
      await sendCustomWhatsApp(cleanPhone, rateMsg);
      return;
    } else {
      await sendCustomWhatsApp(cleanPhone, "⚠️ Invalid selection. Please reply with a number between 1 and 3:\n\n1️⃣ Spain Visa & Residency Services\n2️⃣ Property Investment Guidance Service\n3️⃣ Spanish Sworn Translation Services");
      return;
    }
  }

  if (userSession.stage === 'AWAITING_VISA_SELECTION') {
    const choice = cleanMessage.trim();
    const visaCodes = {
      '1': 'dnv',
      '2': 'nlv',
      '3': 'study',
      '4': 'tourist',
      '5': 'business'
    };
    const serviceCode = visaCodes[choice];
    if (serviceCode) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const bookingLink = `${frontendUrl}/#/public/lead-form?source=${encodeURIComponent(detectedSource)}&id=${userSession.leadId || ''}&service=${serviceCode}`;
      const msg = `To select your preferred appointment date and time, please click the booking link below:\n\n🔗 ${bookingLink}`;
      await sendCustomWhatsApp(cleanPhone, msg);
      
      userSession.stage = 'BOOKING_LINK_SENT';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      return;
    } else {
      await sendCustomWhatsApp(cleanPhone, "⚠️ Invalid selection. Please reply with a number between 1 and 5:\n\n1️⃣ Digital Nomad Residency (DNV)\n2️⃣ Non Lucrative Residency (NLV)\n3️⃣ Study Visa\n4️⃣ Spain Tourist Visa\n5️⃣ Self Employed / Business Residency");
      return;
    }
  }

  if (userSession.stage === 'AWAITING_TRANSLATION_CONFIRM') {
    if (cleanMessage.includes('yes') || cleanMessage === 'y') {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const uploadLink = `${frontendUrl}/#/public/sworn-translation?id=${userSession.leadId || ''}`;
      const msg = `Please click the link below to upload your documents (PDF format only) for word-count analysis and payment setup:\n\n🔗 ${uploadLink}`;
      await sendCustomWhatsApp(cleanPhone, msg);
      
      userSession.stage = 'BOOKING_LINK_SENT';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      return;
    } else if (cleanMessage.includes('no') || cleanMessage === 'n') {
      userSession.stage = 'INIT';
      await redis.set(sessionKey, JSON.stringify(userSession), 'EX', SESSION_TIMEOUT);
      await sendCustomWhatsApp(cleanPhone, "Selection reset. Type *'menu'* to display main options again.");
      return;
    } else {
      await sendCustomWhatsApp(cleanPhone, "⚠️ Please confirm by replying *'YES'* or *'NO'*.");
      return;
    }
  }

  // 4. Subsequent messages: Hand off to AI or Agent
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
