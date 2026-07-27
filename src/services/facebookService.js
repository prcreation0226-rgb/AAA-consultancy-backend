const axios = require('axios');

const META_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const FACEBOOK_API_URL = 'https://graph.facebook.com/v17.0';

/**
 * Sends a Facebook Messenger direct message to a user.
 * Fallbacks to mock logging if Page Access Token is not configured.
 */
exports.sendMessengerMessage = async (recipientId, text) => {
  if (!META_ACCESS_TOKEN) {
    console.log(`[Facebook Service Stub] (Simulating Messenger to ${recipientId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`${FACEBOOK_API_URL}/me/messages`, {
      recipient: { id: recipientId },
      message: { text }
    }, {
      params: { access_token: META_ACCESS_TOKEN }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service] Error sending message:', err.response?.data || err.message);
    throw err;
  }
};

/**
 * Replies to a comment on a Facebook Page feed post.
 */
exports.replyToFacebookComment = async (commentId, text) => {
  if (!META_ACCESS_TOKEN) {
    console.log(`[Facebook Service Stub] (Simulating Feed comment reply to ID ${commentId}): "${text}"`);
    return { success: true, isMock: true };
  }

  try {
    const response = await axios.post(`${FACEBOOK_API_URL}/${commentId}/comments`, {
      message: text
    }, {
      params: { access_token: META_ACCESS_TOKEN }
    });
    return { success: true, data: response.data };
  } catch (err) {
    console.error('[Facebook Service] Error replying to comment:', err.response?.data || err.message);
    throw err;
  }
};
