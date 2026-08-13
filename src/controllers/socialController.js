const twilio = require('twilio');
const prisma = require('../config/db');

// Retrieve Twilio Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

const isTwilioConfigured = !!(
  TWILIO_ACCOUNT_SID &&
  TWILIO_ACCOUNT_SID.startsWith('AC') &&
  TWILIO_AUTH_TOKEN &&
  TWILIO_WHATSAPP_FROM
);

/**
 * Clean phone number function
 */
function cleanPhoneNumber(phone) {
  let clean = phone.trim();
  if (clean.startsWith('whatsapp:')) {
    clean = clean.substring(9);
  }
  clean = clean.replace(/[^\d+]/g, '');
  if (!clean.startsWith('+')) {
    clean = '+' + clean;
  }
  return clean;
}

const parseMessageContent = (content) => {
  if (!content) return { text: '', mediaUrl: null };
  const fileMatch = content.match(/\[FILE:\s*(.+?)\]/);
  if (fileMatch) {
    const mediaUrl = fileMatch[1];
    const text = content.replace(/\[FILE:\s*(.+?)\]/, '').trim();
    return { text, mediaUrl };
  }
  return { text: content, mediaUrl: null };
};

/**
 * Get all conversations grouped by phone number
 */
exports.getConversations = async (req, res) => {
  try {
    // 1. Parallel fetch of all clients, leads, and logs with respondedByUser included
    const [allClients, allLeads, logs] = await Promise.all([
      prisma.client.findMany({
        select: { id: true, phone: true, firstName: true, lastName: true, status: true, email: true }
      }),
      prisma.lead.findMany({
        select: { id: true, phone: true, firstName: true, lastName: true, status: true, email: true, clientId: true }
      }),
      prisma.communicationLog.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          respondedByUser: {
            select: { id: true, fullName: true, role: true, avatar: true }
          }
        }
      })
    ]);

    // 2. Group logs by normalized digit phone key in memory (0 DB overhead)
    const logsByPhoneMap = {};
    const conversationsOrderMap = {};
    const uniquePhones = [];

    for (const log of logs) {
      if (!log.phone) continue;
      const cleanPh = cleanPhoneNumber(log.phone);
      const numDigits = cleanPh.replace(/\D/g, '');
      const key = numDigits || cleanPh;

      if (!logsByPhoneMap[key]) {
        logsByPhoneMap[key] = [];
        uniquePhones.push(cleanPh);
      }
      logsByPhoneMap[key].push(log);
      conversationsOrderMap[cleanPh] = log; // keeps track of latest log
    }

    // Sort uniquePhones by newest log date descending
    uniquePhones.sort((a, b) => {
      const dateA = new Date(conversationsOrderMap[a]?.createdAt || 0);
      const dateB = new Date(conversationsOrderMap[b]?.createdAt || 0);
      return dateB - dateA;
    });

    const isApplicantPlaceholder = (val) => {
      if (!val) return true;
      const normalized = val.trim().toLowerCase();
      return normalized === '' || normalized === 'applicant' || normalized.includes('applicant');
    };

    // 3. Resolve Meta User placeholder names & avatars to real profiles
    const instagramService = require('../services/instagramService');
    const profileAvatars = {};

    await Promise.all(
      uniquePhones.map(async (cleanPh) => {
        const numberPart = cleanPh.replace(/\D/g, '');
        const key = numberPart || cleanPh;
        const messagesLogs = logsByPhoneMap[key] || [];
        const latestLog = messagesLogs[messagesLogs.length - 1];

        if (latestLog && (latestLog.channel === 'INSTAGRAM' || latestLog.channel === 'instagram')) {
          try {
            const igProfile = await instagramService.getInstagramUserProfile(cleanPh);
            if (igProfile) {
              if (igProfile.avatar) profileAvatars[cleanPh] = igProfile.avatar;
              const rawName = latestLog.name || '';
              if (!rawName || rawName.startsWith('Meta User')) {
                const fetchedName = igProfile.name || igProfile.username || 'Instagram User';
                messagesLogs.forEach(m => { m.name = fetchedName; });
                await prisma.communicationLog.updateMany({
                  where: { phone: cleanPh },
                  data: { name: fetchedName }
                }).catch(e => console.warn('Could not update IG name in DB:', e.message));
              }
            }
          } catch (err) {
            console.warn('Profile fetch error:', err.message);
          }
        } else if (latestLog && (latestLog.channel === 'FACEBOOK' || latestLog.channel === 'facebook')) {
          try {
            const facebookService = require('../services/facebookService');
            const fbProfile = await facebookService.getFacebookUserProfile(cleanPh);
            if (fbProfile) {
              if (fbProfile.avatar) profileAvatars[cleanPh] = fbProfile.avatar;
              const rawName = latestLog.name || '';
              if (!rawName || rawName.startsWith('Meta User')) {
                const fetchedName = fbProfile.name || 'Facebook Client';
                messagesLogs.forEach(m => { m.name = fetchedName; });
                await prisma.communicationLog.updateMany({
                  where: { phone: cleanPh },
                  data: { name: fetchedName }
                }).catch(e => console.warn('Could not update FB name in DB:', e.message));
              }
            }
          } catch (err) {
            console.warn('FB Profile fetch error:', err.message);
          }
        }
      })
    );

    // 4. Build conversations in memory
    const conversations = uniquePhones.map(cleanPh => {
      const numberPart = cleanPh.replace(/\D/g, '');
      const key = numberPart || cleanPh;
      const messagesLogs = logsByPhoneMap[key] || [];
      const latestLog = messagesLogs[messagesLogs.length - 1] || conversationsOrderMap[cleanPh];

      // Safe matching with clients & leads
      const client = allClients.find(c => c.phone && c.phone.replace(/\D/g, '').includes(numberPart));
      const lead = allLeads.find(l => l.phone && l.phone.replace(/\D/g, '').includes(numberPart));

      let name = cleanPh;
      let status = 'New Lead';
      let email = null;

      if (client && !isApplicantPlaceholder(`${client.firstName} ${client.lastName}`)) {
        name = `${client.firstName} ${client.lastName}`.trim();
        status = client.status || 'Under Process';
        email = client.email;
      } else if (lead && !isApplicantPlaceholder(`${lead.firstName} ${lead.lastName}`)) {
        name = `${lead.firstName} ${lead.lastName}`.trim();
        status = lead.status || 'New Lead';
        email = lead.email;
      } else {
        const latestInboundLog = messagesLogs.slice().reverse().find(m => m.direction === 'INBOUND');
        if (latestInboundLog && latestInboundLog.name && !isApplicantPlaceholder(latestInboundLog.name)) {
          name = latestInboundLog.name.trim();
        } else if (latestLog && latestLog.name && !isApplicantPlaceholder(latestLog.name) && latestLog.direction !== 'OUTBOUND') {
          name = latestLog.name.trim();
        }
      }

      if (isApplicantPlaceholder(name)) {
        name = cleanPh;
      }

      const messages = messagesLogs.map(m => {
        const parsed = parseMessageContent(m.content);
        return {
          id: m.id,
          sender: m.direction === 'INBOUND' ? 'customer' : (m.direction === 'SYSTEM' ? 'system' : 'agent'),
          text: parsed.text,
          mediaUrl: parsed.mediaUrl,
          rawTimestamp: m.createdAt,
          timestamp: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          respondedBy: m.respondedByUser ? {
            id: m.respondedByUser.id,
            name: m.respondedByUser.fullName,
            role: m.respondedByUser.role,
            avatar: m.respondedByUser.avatar
          } : (m.direction === 'OUTBOUND' ? { name: 'AI Bot', role: 'Automation' } : null)
        };
      });

      const unreadCount = messagesLogs.filter(m => m.direction === 'INBOUND' && !m.readStatus).length;

      // 24-Hour WhatsApp Customer Session Window calculation (Safe against null/invalid dates)
      const latestInboundLog = messagesLogs.slice().reverse().find(m => m.direction === 'INBOUND');
      const lastInboundAt = latestInboundLog ? latestInboundLog.createdAt : null;
      const windowMillis = 24 * 60 * 60 * 1000;
      let isWindowOpen = false;
      let windowExpiresAt = null;
      let remainingMinutes = 0;

      if (lastInboundAt) {
        const inboundTime = new Date(lastInboundAt).getTime();
        if (!isNaN(inboundTime)) {
          isWindowOpen = (Date.now() - inboundTime) <= windowMillis;
          const expireTime = inboundTime + windowMillis;
          windowExpiresAt = new Date(expireTime).toISOString();
          remainingMinutes = isWindowOpen ? Math.max(0, Math.floor((expireTime - Date.now()) / (1000 * 60))) : 0;
        }
      }

      // Determine dominant conversation channel: INSTAGRAM > FACEBOOK > TELEGRAM > WHATSAPP
      let conversationChannel = 'WHATSAPP';
      const hasInstagramLog = messagesLogs.some(m => m.channel === 'INSTAGRAM' || m.channel === 'instagram');
      const hasFacebookLog = messagesLogs.some(m => m.channel === 'FACEBOOK' || m.channel === 'facebook');
      const hasTelegramLog = messagesLogs.some(m => m.channel === 'TELEGRAM' || m.channel === 'telegram');

      if (hasInstagramLog) {
        conversationChannel = 'INSTAGRAM';
      } else if (hasFacebookLog) {
        conversationChannel = 'FACEBOOK';
      } else if (hasTelegramLog) {
        conversationChannel = 'TELEGRAM';
      } else if (latestLog && latestLog.channel) {
        conversationChannel = latestLog.channel.toUpperCase();
      }

      let avatar = client?.avatar || lead?.avatar || profileAvatars[cleanPh] || '';
      if (!avatar) {
        avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Client')}&background=4F46E5&color=fff&bold=true&size=128`;
      }

      return {
        id: `conv_phone_${cleanPh.replace(/[^\d]/g, '')}`,
        phone: cleanPh,
        name: name,
        avatar: avatar,
        platform: conversationChannel.toLowerCase(),
        channel: conversationChannel,
        unreadCount: unreadCount,
        status: status,
        email: email,
        leadId: lead ? lead.id : (client ? client.leadId : null),
        clientId: client ? client.id : null,
        messages: messages,
        latestMessage: latestLog ? parseMessageContent(latestLog.content).text : '',
        timestamp: latestLog ? latestLog.createdAt : new Date(),
        isWindowOpen: isWindowOpen,
        lastInboundAt: lastInboundAt,
        windowExpiresAt: windowExpiresAt,
        remainingMinutes: remainingMinutes,
      };
    });

    return res.status(200).json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return res.status(500).json({ error: 'Failed to fetch conversations' });
  }
};

/**
 * Delete a specific message by ID
 */
exports.deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Message ID is required' });

    const message = await prisma.communicationLog.findUnique({ where: { id } });
    if (!message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await prisma.communicationLog.delete({ where: { id } });
    res.json({ success: true, message: 'Message deleted successfully' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
};

/**
 * Clear all messages for a specific phone number
 */
exports.clearChat = async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) return res.status(400).json({ error: 'Phone or ID is required' });

    const rawId = (phone || '').trim();
    const cleanDigits = rawId.replace(/[^\d]/g, '');
    const withPlus = cleanDigits ? `+${cleanDigits}` : rawId;

    const deleteResult = await prisma.communicationLog.deleteMany({
      where: {
        OR: [
          { phone: rawId },
          { phone: cleanDigits },
          { phone: withPlus }
        ]
      }
    });

    res.json({ success: true, message: `Cleared ${deleteResult.count} messages successfully` });
  } catch (error) {
    console.error('Error clearing chat:', error);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
};

/**
 * Get messages history for a specific phone number
 */
exports.getMessagesByPhone = async (req, res) => {
  try {
    const { phone } = req.params;
    const cleanPh = cleanPhoneNumber(phone);
    const numberPart = cleanPh.replace(/\D/g, '');

    // 1. Fetch all logs for this phone number (matching with or without + prefix)
    const logs = await prisma.communicationLog.findMany({
      where: {
        OR: [
          { phone: cleanPh },
          { phone: numberPart },
          { phone: `+${numberPart}` },
          ...(numberPart ? [{ phone: { contains: numberPart } }] : [])
        ]
      },
      orderBy: { createdAt: 'asc' },
      include: {
        respondedByUser: {
          select: { id: true, fullName: true, role: true, avatar: true }
        }
      }
    });

    // 2. Mark incoming messages as read
    await prisma.communicationLog.updateMany({
      where: {
        OR: [
          { phone: cleanPh },
          { phone: numberPart },
          { phone: `+${numberPart}` },
          ...(numberPart ? [{ phone: { contains: numberPart } }] : [])
        ],
        direction: 'INBOUND',
        readStatus: false
      },
      data: { readStatus: true }
    });

    // 3. Map to frontend message format
    const messages = logs.map(log => {
      const parsed = parseMessageContent(log.content);
      return {
        id: log.id,
        sender: log.direction === 'INBOUND' ? 'customer' : (log.direction === 'SYSTEM' ? 'system' : 'agent'),
        text: parsed.text,
        mediaUrl: parsed.mediaUrl,
        timestamp: log.createdAt,
        respondedBy: log.respondedByUser ? {
          id: log.respondedByUser.id,
          name: log.respondedByUser.fullName,
          role: log.respondedByUser.role,
          avatar: log.respondedByUser.avatar
        } : (log.direction === 'OUTBOUND' ? { name: log.name || 'Agent' } : null)
      };
    });

    return res.status(200).json(messages);
  } catch (error) {
    console.error('Error fetching messages by phone:', error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
};

/**
 * Send a free-text message via Twilio and log to DB
 */
exports.sendSocialMessage = async (req, res) => {
  try {
    const { phone, text, mediaUrl, templateName, channel: requestedChannel } = req.body;
    if (!phone) {
      return res.status(400).json({ message: 'Phone or recipient ID is required' });
    }

    const rawPhoneStr = String(phone).trim();
    let channel = (requestedChannel || 'WHATSAPP').toUpperCase();

    // Look up recent log in DB for this recipient to determine exact channel & phone ID format
    const existingLog = await prisma.communicationLog.findFirst({
      where: { OR: [{ phone: rawPhoneStr }, { phone: rawPhoneStr.replace('+', '') }] },
      orderBy: { createdAt: 'desc' }
    });

    if (existingLog && existingLog.channel) {
      channel = existingLog.channel.toUpperCase();
    } else if (!rawPhoneStr.startsWith('+') && rawPhoneStr.length > 12 && !rawPhoneStr.startsWith('971')) {
      channel = 'INSTAGRAM';
    }

    const cleanPh = (channel === 'INSTAGRAM' || channel === 'FACEBOOK') 
      ? rawPhoneStr.replace('+', '') 
      : cleanPhoneNumber(rawPhoneStr);

    const numberPart = cleanPh.replace('+', '');
    const clientRecord = await prisma.client.findFirst({
      where: { phone: { contains: numberPart } }
    });

    const staffUserId = req.user?.id || null;
    const staffName = req.user?.fullName || 'Agent';
    const staffRole = req.user?.role || 'consultant';

    // If templateName is provided (e.g. 'aaa_greeting'), send official Twilio Content Template via whatsappService
    if (templateName && channel === 'WHATSAPP') {
      const { sendWhatsAppMessage } = require('../services/whatsappService');
      const targetName = clientRecord ? `${clientRecord.firstName} ${clientRecord.lastName}`.trim() : 'Client';

      const result = await sendWhatsAppMessage({
        to: cleanPh,
        templateName: templateName,
        nameOverride: staffName,
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: targetName }
            ]
          }
        ]
      });

      if (result && !result.success) {
        return res.status(400).json({
          success: false,
          message: result.error || 'Failed to dispatch template via Twilio WhatsApp API'
        });
      }

      const log = await prisma.communicationLog.findFirst({
        where: { phone: { contains: numberPart }, direction: 'OUTBOUND' },
        orderBy: { createdAt: 'desc' },
        include: {
          respondedByUser: {
            select: { id: true, fullName: true, role: true, avatar: true }
          }
        }
      });

      const respondedByObj = log?.respondedByUser ? {
        id: log.respondedByUser.id,
        name: log.respondedByUser.fullName,
        role: log.respondedByUser.role,
        avatar: log.respondedByUser.avatar
      } : { name: staffName, role: staffRole };

      return res.status(200).json({
        success: true,
        message: 'Template sent successfully via Content SID',
        log: log ? {
          id: log.id,
          sender: 'agent',
          text: parseMessageContent(log.content).text,
          mediaUrl: parseMessageContent(log.content).mediaUrl,
          timestamp: log.createdAt,
          respondedBy: respondedByObj
        } : null
      });
    }
    
    if (!text && !mediaUrl) {
      return res.status(400).json({ message: 'Text or media is required' });
    }

    const displayContent = `${text || ''}${mediaUrl ? `\n[FILE: ${mediaUrl}]` : ''}`.trim();
    let deliveryStatus = 'SENT';
    let failureReason = null;

    // 1. Send via specific channel service
    if (channel === 'INSTAGRAM') {
      console.log(`[Instagram Outbound DM] To: ${cleanPh}, Text: ${displayContent}`);
      const instagramService = require('../services/instagramService');
      try {
        await instagramService.sendInstagramDM(cleanPh, displayContent);
      } catch (igErr) {
        console.error('[Instagram DM Dispatch Error]:', igErr.message);
        deliveryStatus = 'FAILED';
        failureReason = igErr.message;
      }
    } else if (channel === 'FACEBOOK') {
      console.log(`[Facebook Outbound Messenger] To: ${cleanPh}, Text: ${displayContent}`);
      const facebookService = require('../services/facebookService');
      try {
        await facebookService.sendMessengerMessage(cleanPh, displayContent);
      } catch (fbErr) {
        console.error('[Facebook Messenger Dispatch Error]:', fbErr.message);
        deliveryStatus = 'FAILED';
        failureReason = fbErr.message;
      }
    } else if (channel === 'TELEGRAM') {
      console.log(`[Telegram Outbound] To: ${cleanPh}, Text: ${displayContent}`);
      const telegramService = require('../services/telegramService');
      try {
        await telegramService.sendTelegramMessage(cleanPh, displayContent);
      } catch (tgErr) {
        console.error('[Telegram Dispatch Error]:', tgErr.message);
        deliveryStatus = 'FAILED';
        failureReason = tgErr.message;
      }
    } else {
      const twilioTo = `whatsapp:${cleanPh}`;
      console.log(`Sending manual WhatsApp message to ${twilioTo}: ${displayContent}`);

      if (isTwilioConfigured) {
        try {
          const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
          await client.messages.create({
            body: text || ' ',
            from: TWILIO_WHATSAPP_FROM,
            to: twilioTo,
            ...(mediaUrl && { mediaUrl: [mediaUrl] })
          });
        } catch (err) {
          console.error('Twilio manual send failed:', err.message);
          deliveryStatus = 'FAILED';
          failureReason = err.message;
        }
      } else {
        console.log(`[MANUAL TWILIO DRY-RUN] To: ${twilioTo}, Text: ${text}`);
      }
    }

    // 3. Log OUTBOUND message to Database
    const log = await prisma.communicationLog.create({
      data: {
        clientId: clientRecord ? clientRecord.id : null,
        phone: cleanPh,
        name: staffName,
        respondedByUserId: staffUserId,
        channel: channel,
        direction: 'OUTBOUND',
        content: displayContent,
        deliveryStatus: deliveryStatus,
        failureReason: failureReason
      },
      include: {
        respondedByUser: {
          select: { id: true, fullName: true, role: true, avatar: true }
        }
      }
    });

    const respondedByObj = log.respondedByUser ? {
      id: log.respondedByUser.id,
      name: log.respondedByUser.fullName,
      role: log.respondedByUser.role,
      avatar: log.respondedByUser.avatar
    } : { name: staffName, role: staffRole };

    // 4. Broadcast via WebSockets
    const io = req.app.get('io');
    if (io) {
      io.emit('new_whatsapp_message', {
        phone: cleanPh,
        name: staffName,
        text: text,
        timestamp: log.createdAt,
        sender: 'agent',
        respondedBy: respondedByObj
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      log: {
        id: log.id,
        sender: 'agent',
        text: parseMessageContent(log.content).text,
        mediaUrl: parseMessageContent(log.content).mediaUrl,
        timestamp: log.createdAt,
        respondedBy: respondedByObj
      }
    });
  } catch (error) {
    console.error('Error sending social message:', error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
};

/**
 * Handle direct file upload for social messages
 */
exports.uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    
    // Support both AWS S3 (location) and local storage (filename)
    let mediaUrl;
    if (req.file.location) {
      mediaUrl = req.file.location;
    } else {
      const baseUrl = process.env.VITE_API_URL 
        ? process.env.VITE_API_URL.replace('/api/v1', '') 
        : 'http://localhost:5000';
      mediaUrl = `${baseUrl}/uploads/${req.file.filename}`;
    }

    return res.status(200).json({
      success: true,
      mediaUrl
    });
  } catch (error) {
    console.error('Error uploading social media:', error.message);
    return res.status(500).json({ message: 'Upload failed', error: error.message });
  }
};

/**
 * Proxy Twilio Media URLs to handle HTTP Basic Auth
 */
exports.proxyTwilioMedia = async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.includes('api.twilio.com')) {
      return res.status(400).send('Invalid media URL');
    }

    const axios = require('axios');
    let targetUrl = url;

    console.log(`[Twilio Proxy] Fetching ${targetUrl}`);
    console.log(`[Twilio Proxy] SID defined: ${!!TWILIO_ACCOUNT_SID}`);

    // 1. Fetch the media URL without following redirects to get the S3 link
    try {
      await axios({
        url: targetUrl,
        method: 'GET',
        maxRedirects: 0,
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        }
      });
    } catch (err) {
      if (err.response && [301, 302, 303, 307].includes(err.response.status)) {
        targetUrl = err.response.headers.location;
      } else {
        throw err;
      }
    }

    // 2. Fetch the actual media from the S3 link (without Auth headers)
    const response = await axios({
      url: targetUrl,
      method: 'GET',
      responseType: 'stream'
    });

    res.set('Content-Type', response.headers['content-type']);
    response.data.pipe(res);
  } catch (error) {
    console.error('Twilio media proxy error:', error.message);
    const status = error.response ? error.response.status : 500;
    const data = error.response && error.response.data ? error.response.data : error.message;
    res.status(status).send(`Failed to fetch media: ${error.message} - ${JSON.stringify(data)}`);
  }
};
