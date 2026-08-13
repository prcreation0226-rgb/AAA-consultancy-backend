const axios = require('axios');

const getFacebookAccessToken = async () => {
  if (process.env.META_PAGE_ACCESS_TOKEN) {
    return process.env.META_PAGE_ACCESS_TOKEN;
  }
  try {
    const prisma = require('../config/db');
    const setting = await prisma.companySetting.findFirst();
    return setting?.customizationSettings?.integrations?.socialPlatforms?.facebook?.accessToken || null;
  } catch (e) {
    console.warn('[Facebook Service] Could not fetch token from DB:', e.message);
    return null;
  }
};

/**
 * Sends a Facebook Messenger direct message to a user.
 */
exports.sendMessengerMessage = async (recipientId, text) => {
  const token = await getFacebookAccessToken();
  const cleanRecipientId = (recipientId || '').replace(/[^\d]/g, '');

  if (!token) {
    console.log(`[Facebook Service Stub] (Simulating Messenger to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: cleanRecipientId },
      message: { text }
    }, {
      params: { access_token: token }
    });
    console.log(`[Facebook Messenger Sent Success] Message ID: ${response.data?.message_id}`);
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service Error sending Messenger DM]:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Get Facebook User Profile (Full Name, Profile Pic)
 */
exports.getFacebookUserProfile = async (senderId) => {
  try {
    const token = await getFacebookAccessToken();
    if (!token) return null;
    const cleanId = (senderId || '').replace(/[^\d]/g, '');
    if (!cleanId) return null;

    const response = await axios.get(`https://graph.facebook.com/v19.0/${cleanId}`, {
      params: {
        fields: 'name,first_name,last_name,profile_pic',
        access_token: token
      }
    });

    if (response.data) {
      const name = response.data.name || `${response.data.first_name || ''} ${response.data.last_name || ''}`.trim();
      return { name: name || 'Facebook User', avatar: response.data.profile_pic || null };
    }
  } catch (err) {
    console.warn(`[Facebook Service Profile Error] ${senderId}:`, err.response?.data?.error?.message || err.message);
  }
  return null;
};

/**
 * Replies to a comment on a Facebook Page feed post.
 */
exports.replyToFacebookComment = async (commentId, text) => {
  const token = await getFacebookAccessToken();
  if (!token) {
    console.log(`[Facebook Service Stub] (Simulating Feed comment reply to ID ${commentId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/${commentId}/comments`, {
      message: text
    }, {
      params: { access_token: token }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service Error replying to comment]:', err.response?.data || err.message);
    throw err;
  }
};
