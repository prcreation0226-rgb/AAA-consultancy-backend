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
    // 1. Fetch all clients and leads once to map phones safely without strict substring boundaries
    const allClients = await prisma.client.findMany({
      select: { id: true, phone: true, firstName: true, lastName: true, status: true, email: true }
    });
    const allLeads = await prisma.lead.findMany({
      select: { id: true, phone: true, firstName: true, lastName: true, status: true, email: true, clientId: true }
    });

    // 2. Fetch all communication logs ordered by newest first
    const logs = await prisma.communicationLog.findMany({
      orderBy: { createdAt: 'desc' }
    });

    // 3. Group by unique phone numbers to get the latest message
    const conversationsMap = {};
    const uniquePhones = [];

    for (const log of logs) {
      if (!log.phone) continue;
      const cleanPh = cleanPhoneNumber(log.phone);
      if (!conversationsMap[cleanPh]) {
        conversationsMap[cleanPh] = log;
        uniquePhones.push(cleanPh);
      }
    }

    // 4. Enrich each conversation with Lead/Client details, messages history, and unread count
    const conversations = [];

    for (const cleanPh of uniquePhones) {
      const latestLog = conversationsMap[cleanPh];
      const numberPart = cleanPh.replace(/\D/g, ''); // extract digits only

      // Safe matching: strip all non-digits from db phones to compare accurately
      const client = allClients.find(c => c.phone && c.phone.replace(/\D/g, '').includes(numberPart));
      const lead = allLeads.find(l => l.phone && l.phone.replace(/\D/g, '').includes(numberPart));

      // Fetch message history for this phone
      const messagesLogs = await prisma.communicationLog.findMany({
        where: { phone: cleanPh },
        orderBy: { createdAt: 'asc' },
        include: {
          respondedByUser: {
            select: { id: true, fullName: true, role: true, avatar: true }
          }
        }
      });

      // Determine Name and Status
      let name = cleanPh;
      let status = 'New Lead';
      let email = null;

      const isApplicantPlaceholder = (val) => {
        if (!val) return true;
        const normalized = val.trim().toLowerCase();
        return normalized === '' || normalized === 'applicant' || normalized.includes('applicant');
      };

      if (client && !isApplicantPlaceholder(`${client.firstName} ${client.lastName}`)) {
        name = `${client.firstName} ${client.lastName}`.trim();
        status = client.status || 'Under Process';
        email = client.email;
      } else if (lead && !isApplicantPlaceholder(`${lead.firstName} ${lead.lastName}`)) {
        name = `${lead.firstName} ${lead.lastName}`.trim();
        status = lead.status || 'New Lead';
        email = lead.email;
      } else {
        // Fallback to the latest INBOUND message name to avoid grabbing "Agent"
        const latestInboundLog = messagesLogs.slice().reverse().find(m => m.direction === 'INBOUND');
        if (latestInboundLog && latestInboundLog.name && !isApplicantPlaceholder(latestInboundLog.name)) {
          name = latestInboundLog.name.trim();
        } else if (latestLog.name && !isApplicantPlaceholder(latestLog.name) && latestLog.direction !== 'OUTBOUND') {
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
          } : (m.direction === 'OUTBOUND' ? { name: m.name || 'Agent' } : null)
        };
      });

      // Calculate unread count (INBOUND messages that are unread)
      const unreadCount = await prisma.communicationLog.count({
        where: {
          phone: cleanPh,
          direction: 'INBOUND',
          readStatus: false
        }
      });

      conversations.push({
        id: `conv_phone_${cleanPh.replace(/[^\d]/g, '')}`,
        phone: cleanPh,
        name: name,
        avatar: '',
        platform: 'whatsapp',
        unreadCount: unreadCount,
        status: status,
        email: email,
        leadId: lead ? lead.id : (client ? client.leadId : null),
        clientId: client ? client.id : null,
        messages: messages,
        latestMessage: parseMessageContent(latestLog.content).text,
        timestamp: latestLog.createdAt
      });
    }

    return res.status(200).json(conversations);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
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
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    let cleanPh = cleanPhoneNumber(phone);
    if (!cleanPh.startsWith('+')) {
      cleanPh = '+' + cleanPh.replace(/[^\d]/g, '');
    }

    const deleteResult = await prisma.communicationLog.deleteMany({
      where: { phone: cleanPh }
    });

    if (deleteResult.count === 0) {
      return res.status(404).json({ error: 'No messages found for this phone number' });
    }

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

    // 1. Fetch all logs for this phone number
    const logs = await prisma.communicationLog.findMany({
      where: { phone: cleanPh },
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
        phone: cleanPh,
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
    const { phone, text, mediaUrl } = req.body;
    if (!phone) {
      return res.status(400).json({ message: 'Phone is required' });
    }
    
    // If there is a mediaUrl but no text, allow it (WhatsApp allows media-only)
    if (!text && !mediaUrl) {
      return res.status(400).json({ message: 'Text or media is required' });
    }

    const cleanPh = cleanPhoneNumber(phone);
    const twilioTo = `whatsapp:${cleanPh}`;

    const displayContent = `${text || ''}${mediaUrl ? `\n[FILE: ${mediaUrl}]` : ''}`.trim();
    console.log(`Sending manual WhatsApp message to ${twilioTo}: ${displayContent}`);

    let deliveryStatus = 'SENT';
    let failureReason = null;

    // 1. Send via Twilio if configured
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

    const numberPart = cleanPh.replace('+', '');

    // 2. Check if Client exists for linking
    const clientRecord = await prisma.client.findFirst({
      where: { phone: { contains: numberPart } }
    });

    const staffUserId = req.user?.id || null;
    const staffName = req.user?.fullName || 'Agent';
    const staffRole = req.user?.role || 'consultant';

    // 3. Log OUTBOUND message to Database
    const log = await prisma.communicationLog.create({
      data: {
        clientId: clientRecord ? clientRecord.id : null,
        phone: cleanPh,
        name: staffName,
        respondedByUserId: staffUserId,
        channel: 'WHATSAPP',
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
