const axios = require('axios');

const META_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN; // Instagram API is linked to Page Access Token
const INSTAGRAM_API_URL = 'https://graph.facebook.com/v17.0';

/**
 * Sends an Instagram Direct Message (DM) to a recipient.
 * Fallbacks to mock logging if Page Access Token is not configured.
 */
exports.sendInstagramDM = async (recipientId, text) => {
  const prisma = require('../config/db');
  let accessToken = process.env.META_PAGE_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!accessToken) {
    const setting = await prisma.companySetting.findFirst();
    const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
    accessToken = savedPlatforms?.instagram?.accessToken || savedPlatforms?.facebook?.accessToken;
  }

  const cleanRecipientId = (recipientId || '').replace(/[^\d]/g, '');

  if (!accessToken) {
    console.log(`[Instagram Service Stub] (Simulating IG DM to ${cleanRecipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`https://graph.facebook.com/v19.0/me/messages`, {
      recipient: { id: cleanRecipientId },
      message: { text }
    }, {
      params: { access_token: accessToken }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Instagram Service] Error sending message:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Get Instagram user profile details (Username, Full Name, Profile Pic)
 */
exports.getInstagramUserProfile = async (senderId) => {
  try {
    const prisma = require('../config/db');
    let accessToken = process.env.META_PAGE_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!accessToken) {
      const setting = await prisma.companySetting.findFirst();
      const savedPlatforms = setting?.customizationSettings?.integrations?.socialPlatforms;
      accessToken = savedPlatforms?.instagram?.accessToken || savedPlatforms?.facebook?.accessToken;
    }

    if (!accessToken) return null;

    const cleanId = (senderId || '').replace(/[^\d]/g, '');
    if (!cleanId) return null;

    const response = await axios.get(`${INSTAGRAM_API_URL}/${cleanId}`, {
      params: {
        fields: 'name,username,profile_pic',
        access_token: accessToken
      }
    });

    if (response.data) {
      const name = response.data.name || (response.data.username ? `@${response.data.username}` : null);
      const username = response.data.username ? `@${response.data.username}` : name;
      const avatar = response.data.profile_pic || null;

      return { name: name || username, username, avatar };
    }
  } catch (err) {
    console.warn(`[Instagram Service] Could not fetch user profile for ${senderId}:`, err.response?.data?.error?.message || err.message);
  }
  return null;
};
