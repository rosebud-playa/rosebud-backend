const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ENTITIES = [
  { id: 'sales', name: 'Sales' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'engineering', name: 'Engineering' },
  { id: 'ga', name: 'G&A' },
];

const ENTITY_BASE = {
  sales: { service: 8000, headcount: 14, salary: 9500, marketing: 15000, software: 3200, travel: 4000 },
  marketing: { service: 0, headcount: 8, salary: 8800, marketing: 42000, software: 5400, travel: 2600 },
  engineering: { service: 0, headcount: 22, salary: 12500, marketing: 0, software: 18000, travel: 1800 },
  ga: { service: 5000, headcount: 6, salary: 9800, marketing: 0, software: 2100, travel: 1200 },
};

// Product hierarchy: Category -> Product. Only the Sales entity carries real
// product revenue (matches the old single-line-item behavior for every other
// entity, which stays at zero).
const PRODUCT_CATEGORIES = [
  { id: 'hardware', name: 'Hardware' },
  { id: 'software', name: 'Software' },
];
const PRODUCTS = [
  { id: 'core_widget', name: 'Core Widget', category: 'hardware' },
  { id: 'widget_mini', name: 'Widget Mini', category: 'hardware' },
  { id: 'platform_license', name: 'Platform License', category: 'software' },
  { id: 'addon_modules', name: 'Add-on Modules', category: 'software' },
];
const PRODUCT_BASE = {
  core_widget: { units: 500, price: 120 },
  widget_mini: { units: 700, price: 45 },
  platform_license: { units: 300, price: 200 },
  addon_modules: { units: 450, price: 60 },
};

// Only 'input' type accounts are ever stored — rollups and formulas are always
// recomputed client-side from these.
const INPUT_ACCOUNTS = ['units_sold', 'unit_price', 'service_revenue', 'headcount', 'avg_salary', 'marketing_spend', 'software', 'travel'];
// These two accounts carry a Product dimension in addition to Entity — every
// other input account is entity-only (stored under the sentinel product 'none').
const PRODUCT_DIMENSIONED_ACCOUNTS = ['units_sold', 'unit_price'];

function seedValues(multiplier, jitter) {
  const data = {};
  ENTITIES.forEach((e) => {
    const base = ENTITY_BASE[e.id];
    const acc = { units_sold: {}, unit_price: {}, service_revenue: {}, headcount: {}, avg_salary: {}, marketing_spend: {}, software: {}, travel: {} };
    PRODUCTS.forEach((p) => { acc.units_sold[p.id] = {}; acc.unit_price[p.id] = {}; });

    MONTHS.forEach((m, mi) => {
      const growth = 1 + mi * 0.012;
      const noise = jitter ? 0.94 + Math.random() * 0.12 : 1;

      PRODUCTS.forEach((p) => {
        const pb = PRODUCT_BASE[p.id];
        if (e.id === 'sales') {
          acc.units_sold[p.id][m] = Math.round(pb.units * growth * multiplier * noise);
          acc.unit_price[p.id][m] = Math.round(pb.price * (0.97 + multiplier * 0.03));
        } else {
          acc.units_sold[p.id][m] = 0;
          acc.unit_price[p.id][m] = 0;
        }
      });

      acc.service_revenue[m] = Math.round(base.service * growth * multiplier * noise);
      acc.headcount[m] = base.headcount + Math.floor(mi / 4);
      acc.avg_salary[m] = base.salary;
      acc.marketing_spend[m] = Math.round(base.marketing * growth * multiplier * noise);
      acc.software[m] = base.software;
      acc.travel[m] = Math.round(base.travel * (0.85 + Math.random() * 0.3));
    });
    data[e.id] = acc;
  });
  return data;
}

module.exports = {
  MONTHS, ENTITIES, ENTITY_BASE, INPUT_ACCOUNTS,
  PRODUCT_CATEGORIES, PRODUCTS, PRODUCT_DIMENSIONED_ACCOUNTS,
  seedValues,
};
