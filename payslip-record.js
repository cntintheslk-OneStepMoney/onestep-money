const MONEY_TOLERANCE = 0.02;
const PERIOD_PATTERN = /^20\d{2}-(?:0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

export function payslipEditorItem(record = {}) {
  return {
    ...record,
    earningsText: formatPayslipLineItems(record.earnings),
    deductionsText: formatPayslipLineItems(record.deductions)
  };
}

export function buildPayslipRecord(input, existing = {}) {
  const errors = [];
  const period = String(input.period || '').trim();
  const payDate = String(input.payDate || '').trim();
  const grossPay = moneyValue(input.grossPay);
  const netPay = moneyValue(input.netPay);
  const earningsResult = parsePayslipLineItems(input.earningsText, 'earning');
  const deductionsResult = parsePayslipLineItems(input.deductionsText, 'deduction');
  errors.push(...earningsResult.errors, ...deductionsResult.errors);

  if (!PERIOD_PATTERN.test(period)) errors.push('Pay month must use YYYY-MM.');
  if (!DATE_PATTERN.test(payDate) || !validDate(payDate)) errors.push('Pay date must be a real date using YYYY-MM-DD.');
  if (payDate && period && payDate.slice(0, 7) !== period) errors.push('Pay date must fall within the selected pay month.');
  if (grossPay === null || grossPay < 0) errors.push('Gross pay must be zero or more.');
  if (netPay === null || netPay < 0) errors.push('Net pay must be zero or more.');

  const earningsTotal = roundMoney(earningsResult.items.reduce((sum, item) => sum + item.amount, 0));
  const totalDeductions = roundMoney(deductionsResult.items.reduce((sum, item) => sum + item.amount, 0));
  if (grossPay !== null && earningsResult.items.length && Math.abs(earningsTotal - grossPay) > MONEY_TOLERANCE) {
    errors.push(`Payment lines total £${earningsTotal.toFixed(2)}, not gross pay £${grossPay.toFixed(2)}.`);
  }
  if (grossPay !== null && netPay !== null && Math.abs(roundMoney(grossPay - totalDeductions) - netPay) > MONEY_TOLERANCE) {
    errors.push(`Gross pay less itemised deductions must equal net pay (expected £${roundMoney(grossPay - totalDeductions).toFixed(2)}).`);
  }

  const record = {
    ...existing,
    id: existing.id || String(input.id || ''),
    provider: existing.provider || String(input.provider || 'manual').trim() || 'manual',
    period,
    payDate,
    annualSalary: moneyValue(input.annualSalary),
    grossPay,
    taxablePay: moneyValue(input.taxablePay),
    niablePay: moneyValue(input.niablePay),
    totalDeductions,
    netPay,
    taxCode: String(input.taxCode || '').trim(),
    taxBasis: String(input.taxBasis || '').trim(),
    niCategory: String(input.niCategory || '').trim(),
    employerPayeReference: String(input.employerPayeReference || '').trim(),
    grossPayYtd: moneyValue(input.grossPayYtd),
    taxablePayYtd: moneyValue(input.taxablePayYtd),
    niablePayYtd: moneyValue(input.niablePayYtd),
    payeYtd: moneyValue(input.payeYtd),
    niEmployeeYtd: moneyValue(input.niEmployeeYtd),
    niEmployerYtd: moneyValue(input.niEmployerYtd),
    earnings: earningsResult.items,
    deductions: deductionsResult.items,
    notes: String(input.notes || '').trim(),
    source: existing.source || 'Manual entry'
  };

  return { valid: errors.length === 0, errors, record, earningsTotal, totalDeductions };
}

export function parsePayslipLineItems(value, type) {
  const items = [];
  const errors = [];
  const lines = String(value || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = line.match(/^(.*?)(?:\s*[|:]\s*|\s{2,}|\t)([-+]?\s*(?:£|GBP)?\s*[\d,]+\.\d{1,2})$/i)
      || line.match(/^(.*?)\s+([-+]?\s*(?:£|GBP)?\s*[\d,]+\.\d{1,2})$/i);
    if (!match || !match[1].trim()) {
      errors.push(`${type === 'earning' ? 'Payment' : 'Deduction'} line ${index + 1} must use “Description | 0.00”.`);
      continue;
    }
    const amount = moneyValue(match[2]);
    if (amount === null || amount < 0) {
      errors.push(`${type === 'earning' ? 'Payment' : 'Deduction'} line ${index + 1} must have an amount of zero or more.`);
      continue;
    }
    const name = match[1].trim();
    items.push({ id: stableLineId(type, name, index), name, amount, type, notes: '' });
  }
  return { items, errors };
}

export function formatPayslipLineItems(items = []) {
  return (items || []).map((item) => `${item.name} | ${Number(item.amount || 0).toFixed(2)}`).join('\n');
}

function moneyValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? roundMoney(value) : null;
  const number = Number(String(value).replace(/£|GBP|,/gi, '').trim());
  return Number.isFinite(number) ? roundMoney(number) : null;
}

function stableLineId(type, name, index) {
  const compact = `${type}-${name}-${index}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return compact || `${type}-${index + 1}`;
}

function validDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
