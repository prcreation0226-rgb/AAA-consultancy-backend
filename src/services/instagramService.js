const axios = require('axios');

const META_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN; // Instagram API is linked to Page Access Token
const INSTAGRAM_API_URL = 'https://graph.facebook.com/v17.0';

/**
 * Sends an Instagram Direct Message (DM) to a recipient.
 * Fallbacks to mock logging if Page Access Token is not configured.
 */
exports.sendInstagramDM = async (recipientId, text) => {
  if (!META_ACCESS_TOKEN) {
    console.log(`[Instagram Service Stub] (Simulating IG DM to ${recipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`${INSTAGRAM_API_URL}/me/messages`, {
      recipient: { id: recipientId },
      message: { text }
    }, {
      params: { access_token: META_ACCESS_TOKEN }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Instagram Service] Error sending message:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Replies to a comment on an Instagram media post.
 */
exports.replyToInstagramComment = async (commentId, text) => {
  if (!META_ACCESS_TOKEN) {
    console.log(`[Instagram Service Stub] (Simulating IG comment reply to ID ${commentId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`${INSTAGRAM_API_URL}/${commentId}/replies`, {
      message: text
    }, {
      params: { access_token: META_ACCESS_TOKEN }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Instagram Service] Error replying to comment:', err.response?.data || err.message);
    throw err;
  }
};
