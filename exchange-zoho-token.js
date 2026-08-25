const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function exchangeTokenFinal() {
  const clientId = '1000.CO745VR02B4J21LS9VU1DUNBNRAN1T';
  const clientSecret = 'faa1da5ddec0ed91023c470dfbd9e9aa70834819e3';
  const code = '1000.0f88734af8c6ce9003de160e1c420be3.45626c6fdfde50dd95595861afad877f';
  const orgId = '932776843';

  console.log('1. Exchanging code for Permanent Refresh Token...');
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: 'https://api-console.zoho.com/'
    });

    const res = await axios.post('https://accounts.zoho.com/oauth/v2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('\n--- Exchange Result ---');
    console.log(JSON.stringify(res.data, null, 2));

    if (res.data.refresh_token) {
      console.log('\n✅ PERMANENT REFRESH TOKEN:', res.data.refresh_token);

      // Write variables to backend/.env
      const envPath = path.join(__dirname, '.env');
      let envContent = '';
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
      }

      const newVars = `
# Zoho Invoice API Integration
ZOHO_ORGANIZATION_ID=${orgId}
ZOHO_CLIENT_ID=${clientId}
ZOHO_CLIENT_SECRET=${clientSecret}
ZOHO_REFRESH_TOKEN=${res.data.refresh_token}
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_URL=https://www.zohoapis.com/invoice/v3
`;

      if (!envContent.includes('ZOHO_ORGANIZATION_ID')) {
        envContent += newVars;
        fs.writeFileSync(envPath, envContent, 'utf8');
        console.log('[.env Updated] Saved Zoho Invoice API keys to .env');
      }
    }
  } catch (err) {
    console.error('Exchange error:', err.response?.data || err.message);
  }
}

exchangeTokenFinal();
