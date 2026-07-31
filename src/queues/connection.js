const { Redis } = require('ioredis');
require('dotenv').config();

let connection;

const isProductionWithoutRedis = process.env.NODE_ENV === 'production' && (!process.env.REDIS_URL || process.env.REDIS_URL.includes('127.0.0.1'));
const isRedisDisabled = process.env.DISABLE_REDIS === 'true' || !process.env.REDIS_URL || isProductionWithoutRedis;

if (isRedisDisabled) {
  console.log('Redis is disabled or unconfigured. Using Mock Redis connection.');

  class MockRedis {
    constructor() {
      this.store = {};
    }

    on(event, callback) {
      return this;
    }

    async get(key) {
      return this.store[key] || null;
    }

    async set(key, value, ...args) {
      this.store[key] = value;
      return 'OK';
    }

    async del(key) {
      delete this.store[key];
      return 1;
    }

    async quit() {
      return 'OK';
    }

    async disconnect() {
      return 'OK';
    }
  }

  connection = new MockRedis();
} else {
  connection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableOfflineQueue: false,
    retryStrategy(times) {
      if (times > 3) {
        return null; // Stop retrying after 3 attempts to prevent CPU/loop starvation
      }
      return Math.min(times * 1000, 3000);
    },
  });

  connection.on('error', () => {
    // Quiet error handler to avoid console spam
  });
}

module.exports = { connection };
