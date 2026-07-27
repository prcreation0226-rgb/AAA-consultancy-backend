let DEFAULT_CUSTOMIZATION = {
  rolesDefinition: [
    { id: 'admin', label: 'Admin (General Manager)' },
    { id: 'operations', label: 'Operations Admin' },
    { id: 'finance', label: 'Finance Officer' },
    { id: 'consultant', label: 'Consultant / Visa Agent' },
    { id: 'marketing', label: 'Marketing Executive' }
  ],
  admin: {
    menus: ['Dashboard', 'Agents', 'Active Cases', 'Doc Verification', 'Finance', 'Closed Cases', 'Clients', 'Leads', 'Social Inbox', 'Marketing', 'Calendar', 'All Agents Performance', 'Integrations'],
    cards: ['Total Clients', 'Today\'s Clients', 'Total Consultations', 'Today\'s Consultations', 'Upcoming Meetings', 'Pending Payments', 'Total Revenue', 'Active Cases', 'Completed Cases', 'Lost Consultations', 'Revenue Today', 'Outstanding Revenue', 'Refunded (50% Rejections)'],
    features: ['canEditTranslationRates']
  },
  operations: {
    menus: ['Dashboard', 'Agents', 'Active Cases', 'Doc Verification', 'Closed Cases', 'Clients', 'Leads', 'Social Inbox', 'Marketing', 'Calendar', 'All Agents Performance'],
    cards: ['Total Clients', 'Today\'s Clients', 'Total Consultations', 'Today\'s Consultations', 'Upcoming Meetings', 'Active Cases', 'Completed Cases'],
    features: []
  },
  finance: {
    menus: ['Dashboard', 'Finance'],
    cards: ['Total Revenue', 'Pending Payments'],
    features: []
  },
  consultant: {
    menus: ['Dashboard', 'Clients', 'Leads', 'Social Inbox', 'Calendar'],
    cards: ['Upcoming Meetings', 'Active Cases'],
    features: []
  },
  marketing: {
    menus: ['Dashboard', 'Leads', 'Marketing'],
    cards: ['Total Consultations', 'Today\'s Consultations'],
    features: []
  },
  documentChecklists: {
    dnv: {
      main: ['Passport (Copy)', 'Employment Verification Letter', 'Remote Income Bank Statements', 'Social Security Certificate'],
      spouse: ['Passport (Copy)', 'Marriage Certificate'],
      minorChild: ['Passport (Copy)', 'Birth Certificate', 'School Enrollment Confirmation'],
      adultChild: ['Passport (Copy)', 'Proof of Financial Dependency', 'Clean Criminal Record Certificate'],
      parent: ['Passport (Copy)', 'Proof of Financial Dependency', 'Medical Insurance Certificate'],
      other: ['Passport (Copy)', 'Relationship Verification Certificate']
    },
    nlv: {
      main: ['Passport (Copy)', 'Spanish Health Insurance Policy', 'Clean Criminal Record Certificate', 'Savings Bank Statements'],
      spouse: ['Passport (Copy)', 'Marriage Certificate'],
      minorChild: ['Passport (Copy)', 'Birth Certificate'],
      adultChild: ['Passport (Copy)', 'Proof of Financial Dependency', 'Clean Criminal Record Certificate'],
      parent: ['Passport (Copy)', 'Proof of Financial Dependency', 'Spanish Health Insurance Policy'],
      other: ['Passport (Copy)', 'Relationship Verification Certificate']
    },
    study: {
      main: ['Passport (Copy)', 'Complutense Admission Letter', 'Medical Certificate', 'Sufficient Funds Guarantee'],
      spouse: ['Passport (Copy)', 'Marriage Certificate'],
      minorChild: ['Passport (Copy)', 'Birth Certificate'],
      adultChild: ['Passport (Copy)', 'Proof of Financial Dependency'],
      parent: ['Passport (Copy)', 'Proof of Financial Dependency'],
      other: ['Passport (Copy)']
    },
    property: {
      main: ['Passport (Copy)', 'Property Purchase Escrow Registry', 'Spanish Bank Account Certificate'],
      spouse: ['Passport (Copy)', 'Marriage Certificate'],
      minorChild: ['Passport (Copy)', 'Birth Certificate'],
      adultChild: ['Passport (Copy)', 'Proof of Financial Dependency'],
      parent: ['Passport (Copy)', 'Proof of Financial Dependency'],
      other: ['Passport (Copy)']
    },
    family: {
      main: ['Passport (Copy)', 'Relationship Verification Certificate', 'Sufficient Income Proof'],
      spouse: ['Passport (Copy)', 'Marriage Certificate'],
      minorChild: ['Passport (Copy)', 'Birth Certificate'],
      adultChild: ['Passport (Copy)', 'Proof of Financial Dependency', 'Clean Criminal Record Certificate'],
      parent: ['Passport (Copy)', 'Proof of Financial Dependency', 'Medical Insurance Certificate'],
      other: ['Passport (Copy)', 'Relationship Verification Certificate']
    }
  },
  flowAutomationSettings: {
    defaultMeetingDuration: 30,
    joinGracePeriod: 10,
    adultAgeThreshold: 18,
    bookingAllowedStart: '09:00',
    bookingAllowedEnd: '18:00',
    welcomeEmailSubject: 'Welcome to AAA Business Consultancy - Your Client Portal is Ready! ✈️',
    welcomeEmailTemplate: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #2d3748;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="color: #4f46e5; margin: 0;">AAA Business Consultancy</h2>
    <p style="color: #718096; font-size: 14px; margin: 4px 0 0;">Relocation & Spain Visa Services</p>
  </div>
  <h3 style="color: #1a202c; border-bottom: 1px solid #edf2f7; padding-bottom: 10px;">Welcome to the Client Portal! 🎉</h3>
  <p>Hello <strong>{client_name}</strong>,</p>
  <p>Congratulations! Your file has been initialized. We have successfully set up your profile and created your Client Portal account.</p>
  
  <p>You can now log in to select your relocation package, complete your payment, and upload your visa documents.</p>
  
  <div style="background-color: #f7fafc; border-left: 4px solid #4f46e5; padding: 16px; margin: 20px 0; border-radius: 4px;">
    <h4 style="margin: 0 0 8px; color: #4f46e5;">Access Credentials</h4>
    <p style="margin: 4px 0;"><strong>Portal URL:</strong> <a href="{portal_url}" style="color: #4f46e5; text-decoration: underline;">Login Here</a></p>
    <p style="margin: 4px 0;"><strong>Username:</strong> {username}</p>
    <p style="margin: 4px 0;"><strong>Temporary Password:</strong> <code style="background-color: #edf2f7; padding: 2px 6px; border-radius: 4px; font-weight: bold; color: #e11d48;">{temp_password}</code></p>
  </div>
  
  <p style="font-size: 13px; color: #e11d48; font-weight: 600;">
    ⚠️ Note: For your security, you will be prompted to change this temporary password immediately upon your first login.
  </p>
  
  <p>If you have any questions, feel free to contact your assigned consultant.</p>
  <p style="font-size: 13px; color: #718096; margin-top: 30px; border-top: 1px solid #edf2f7; padding-top: 10px;">
    This is an automated notification from AAA Visa CRM. Please do not reply directly to this email.
  </p>
</div>`
  }
};

const getCustomizationSettings = async (req, res) => {
  res.json(DEFAULT_CUSTOMIZATION);
};

const updateCustomizationSettings = async (req, res) => {
  try {
    const { settings } = req.body;
    
    // In a real database, you'd save this to a RolePermissions table.
    // Here we update the in-memory object for demonstration.
    if (settings) {
      DEFAULT_CUSTOMIZATION = { ...DEFAULT_CUSTOMIZATION, ...settings };
    }

    // BROADCAST the change using Socket.io to all affected users
    const io = req.app.get('io');
    if (io && settings) {
      Object.keys(settings).forEach(key => {
        if (key !== 'allowAdminCustomOverrides') {
          console.log(`Emitting permissions_updated to room: role:${key} and user:${key}`);
          io.to(`role:${key}`).emit('permissions_updated', settings[key]);
          io.to(`user:${key}`).emit('permissions_updated', settings[key]);
        }
      });
    }

    res.json({ success: true, message: 'Permissions updated successfully', data: DEFAULT_CUSTOMIZATION });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

let CURRENT_LEAD_STAGES = [
  { id: 'stage_new_lead', name: 'New Lead', type: 'lead', color: '#2196F3', emoji: '🆕' },
  { id: 'stage_hot_lead', name: 'Hot Lead', type: 'lead', color: '#FF9800', emoji: '🔥' },
  { id: 'stage_processing', name: 'Processing', type: 'lead', color: '#3F51B5', emoji: '⚙️' },
  { id: 'stage_under_consultation', name: 'Under Consultation', type: 'lead', color: '#9C27B0', emoji: '📅' },
  { id: 'stage_waiting_payment', name: 'Waiting for Payment', type: 'client', color: '#FF5722', emoji: '💳' },
  { id: 'stage_documents_pending', name: 'Documents Pending', type: 'client', color: '#E91E63', emoji: '📎' },
  { id: 'stage_under_process', name: 'Under Process', type: 'client', color: '#03A9F4', emoji: '📂' },
  { id: 'stage_completed', name: 'Completed', type: 'client', color: '#4CAF50', emoji: '✅' },
  { id: 'stage_closed', name: 'Closed', type: 'client', color: '#9E9E9E', emoji: '🔒' },
  { id: 'stage_cold_lead', name: 'Cold Lead', type: 'lead', color: '#009688', emoji: '❄️' },
  { id: 'stage_lost_lead', name: 'Lost Lead', type: 'lead', color: '#F44336', emoji: '❌' }
];

const getLeadStages = async (req, res) => {
  try {
    const setting = await prisma.companySetting.findFirst();
    if (setting && setting.leadStages && Array.isArray(setting.leadStages) && setting.leadStages.length > 0) {
      return res.json(setting.leadStages);
    }
    res.json(CURRENT_LEAD_STAGES);
  } catch (error) {
    res.json(CURRENT_LEAD_STAGES);
  }
};

const updateLeadStages = async (req, res) => {
  try {
    const stages = req.body;
    if (Array.isArray(stages)) {
      CURRENT_LEAD_STAGES = stages;
      let setting = await prisma.companySetting.findFirst();
      if (!setting) {
        setting = await prisma.companySetting.create({
          data: { leadStages: stages }
        });
      } else {
        setting = await prisma.companySetting.update({
          where: { id: setting.id },
          data: { leadStages: stages }
        });
      }
      res.json({ success: true, message: 'Stages updated and saved to DB successfully', data: stages });
    } else {
      res.status(400).json({ error: 'Invalid stages format' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const getCompanySettings = async (req, res) => {
  try {
    let settings = await prisma.companySetting.findFirst();
    if (!settings) {
      settings = await prisma.companySetting.create({
        data: {}
      });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateCompanySettings = async (req, res) => {
  try {
    const data = req.body;
    let settings = await prisma.companySetting.findFirst();
    if (!settings) {
      settings = await prisma.companySetting.create({ data });
    } else {
      settings = await prisma.companySetting.update({
        where: { id: settings.id },
        data
      });
    }
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getVisaServices = async (req, res) => {
  try {
    const services = await prisma.visaService.findMany();
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateVisaServices = async (req, res) => {
  try {
    const services = req.body;
    for (const s of services) {
      if (s.id && !s.id.startsWith('srv_')) {
        const exists = await prisma.visaService.findUnique({ where: { id: s.id } });
        if (exists) {
          await prisma.visaService.update({
            where: { id: s.id },
            data: {
              name: s.name,
              category: s.category,
              basePrice: s.basePrice,
              active: s.active
            }
          });
        }
      } else {
        await prisma.visaService.create({
          data: {
            name: s.name,
            category: s.category,
            basePrice: s.basePrice,
            active: s.active
          }
        });
      }
    }
    const allServices = await prisma.visaService.findMany();
    res.json(allServices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getPackages = async (req, res) => {
  try {
    const packages = await prisma.relocationPackage.findMany();
    res.json(packages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updatePackages = async (req, res) => {
  try {
    const packages = req.body;
    for (const p of packages) {
      if (p.id && !p.id.startsWith('pkg_')) {
        const exists = await prisma.relocationPackage.findUnique({ where: { id: p.id } });
        if (exists) {
          await prisma.relocationPackage.update({
            where: { id: p.id },
            data: {
              name: p.name,
              description: p.description,
              price: p.price,
              includes: p.includes
            }
          });
        }
      } else {
        await prisma.relocationPackage.create({
          data: {
            name: p.name,
            description: p.description,
            price: p.price,
            includes: p.includes
          }
        });
      }
    }
    const allPkgs = await prisma.relocationPackage.findMany();
    res.json(allPkgs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getEmailTemplates = async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      where: { type: 'email' }
    });
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateEmailTemplates = async (req, res) => {
  try {
    const templates = req.body;
    for (const t of templates) {
      const exists = await prisma.template.findUnique({ where: { id: t.id } });
      if (exists) {
        await prisma.template.update({
          where: { id: t.id },
          data: { subject: t.subject, body: t.body }
        });
      } else {
        await prisma.template.create({
          data: {
            id: t.id,
            type: 'email',
            subject: t.subject,
            body: t.body
          }
        });
      }
    }
    const all = await prisma.template.findMany({ where: { type: 'email' } });
    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getWhatsappTemplates = async (req, res) => {
  try {
    const templates = await prisma.template.findMany({
      where: { type: 'whatsapp' }
    });
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const updateWhatsappTemplates = async (req, res) => {
  try {
    const templates = req.body;
    for (const t of templates) {
      const exists = await prisma.template.findUnique({ where: { id: t.id } });
      if (exists) {
        await prisma.template.update({
          where: { id: t.id },
          data: { body: t.body }
        });
      } else {
        await prisma.template.create({
          data: {
            id: t.id,
            type: 'whatsapp',
            body: t.body
          }
        });
      }
    }
    const all = await prisma.template.findMany({ where: { type: 'whatsapp' } });
    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { 
  getCustomizationSettings, 
  updateCustomizationSettings,
  getCustomization: () => DEFAULT_CUSTOMIZATION,
  getLeadStages,
  updateLeadStages,
  getCompanySettings,
  updateCompanySettings,
  getVisaServices,
  updateVisaServices,
  getPackages,
  updatePackages,
  getEmailTemplates,
  updateEmailTemplates,
  getWhatsappTemplates,
  updateWhatsappTemplates
};
