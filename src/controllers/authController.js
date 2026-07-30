const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { JWT_SECRET, JWT_EXPIRES_IN } = require('../config/jwt');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    let user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    // Auto-seed default superadmin user on fresh deployment if missing
    if (!user && (email.toLowerCase().trim() === 'superadmin@aaaconsultancy.com' || email.toLowerCase().trim() === 'admin@aaaconsultancy.com')) {
      try {
        const salt = await bcrypt.genSalt(10);
        const defaultHash = await bcrypt.hash(password || 'superadmin123', salt);
        user = await prisma.user.create({
          data: {
            email: email.toLowerCase().trim(),
            password: defaultHash,
            fullName: 'Super Admin',
            role: 'super_admin'
          }
        });
        console.log(`[Auto-Seed] Initialized superadmin account: ${email}`);
      } catch (seedErr) {
        console.warn('[Auto-Seed Warning]:', seedErr.message);
      }
    }

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email, name: user.fullName },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.fullName,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        customPermissions: user.customPermissions
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login', error: error.message });
  }
};

const getMe = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        hotlineNumber: true,
        spokenLanguages: true,
        nationalities: true,
        commissionRate: true,
        immigrationBio: true,
        customPermissions: true
      }
    });
    
    if (!user) return res.status(404).json({ message: 'User not found' });
    
    res.json(user);
  } catch (error) {
    console.error('GetMe error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

module.exports = { login, getMe };
