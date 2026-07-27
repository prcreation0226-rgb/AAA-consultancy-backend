require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function testStripe() {
  try {
    console.log('Testing Stripe Connection...');
    console.log('Stripe Key length:', process.env.STRIPE_SECRET_KEY.length);
    
    // Retrieve account details to verify credentials
    const balance = await stripe.balance.retrieve();
    console.log('Stripe Connection successful! Balance response:');
    console.log(JSON.stringify(balance, null, 2));
  } catch (error) {
    console.error('Stripe Connection failed:', error.message);
  }
}

testStripe();
