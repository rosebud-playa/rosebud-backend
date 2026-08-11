const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ENTITIES = [
  { id: 'sales', name: 'Sales' },
  { id: 'marketing', name: 'Marketing' },
  { id: 'engineering', name: 'Engineering' },
  { id: 'ga', name: 'G&A' },
];

const ENTITY_BASE = {
  sales: { units: 1200, price: 85, service: 8000, headcount: 14, salary: 9500, marketing: 15000, software: 3200, travel: 4000 },
  marketing: { units: 0, price: 0, service: 0, headcount: 8, salary: 8800, marketing: 42000, software: 5400, travel: 2600 },
  engineering: { units: 0, price: 0, service: 0, headcount: 22, salary: 12500, marketing: 0, software: 18000, travel: 1800 },
  ga: { units: 0, price: 0, service: 5000, headcount: 6, salary: 9800, marketing: 0, software: 2100, travel: 1200 },
};

// Only 'input' type accounts are ever stored — rollups and formulas are always
// recomputed client-side from these.
const INPUT_ACCOUNTS = ['units_sold', 'unit_price', 'service_revenue', 'headcount', 'avg_salary', 'marketing_spend', 'software', 'travel'];

function seedValues(multiplier, jitter) {
  const data = {};
  ENTITIES.forEach((e) => {
    const base = ENTITY_BASE[e.id];
    const acc = { units_sold: {}, unit_price: {}, service_revenue: {}, headcount: {}, avg_salary: {}, marketing_spend: {}, software: {}, travel: {} };
    MONTHS.forEach((m, mi) => {
      const growth = 1 + mi * 0.012;
      const noise = jitter ? 0.94 + Math.random() * 0.12 : 1;
      acc.units_sold[m] = Math.round(base.units * growth * multiplier * noise);
      acc.unit_price[m] = Math.round(base.price * (0.97 + multiplier * 0.03));
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

module.exports = { MONTHS, ENTITIES, ENTITY_BASE, INPUT_ACCOUNTS, seedValues };
