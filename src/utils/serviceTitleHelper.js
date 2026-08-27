/**
 * Resolves dynamic title, icon, assessment name, and category name based on selected service type.
 * Supports Property Investment Guidance Services and Spain Visa & Residency Services.
 */
function getServiceTitleInfo(serviceType) {
  const service = String(serviceType || '').toLowerCase();

  // 🏠 Property Investment Guidance Service
  if (service.includes('property') || service.includes('investment')) {
    return {
      icon: '🏠',
      title: 'Property Investment Consultation',
      assessmentName: 'Property Investment Guidance Assessment',
      categoryName: 'Property Investment Guidance Services'
    };
  }

  // ✈️ Default: Spain Visa & Residency Services (DNV, NLV, Tourist, Study, etc.)
  return {
    icon: '✈️',
    title: 'Spain Visa Consultation',
    assessmentName: 'Spain Visa Eligibility Assessment',
    categoryName: 'Spain Visa & Residency Services'
  };
}

module.exports = { getServiceTitleInfo };
