import crypto from 'node:crypto';
import path from 'node:path';

const MONEY_PATTERN = /^[-+]?£?-?[\d,]+\.\d{2}$/;
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

export function parseImportedDocument(fileName, payload, requestedKind = 'auto', accountHint = '') {
  const extension = path.extname(fileName).toLowerCase();
  const kind = requestedKind === 'auto' ? inferDocumentKind(fileName, payload?.text || String(payload || '')) : requestedKind;

  if (kind === 'payslip') {
    return parsePayslipText(payload.text || String(payload || ''), fileName);
  }

  if (extension === '.pdf') {
    return parsePdfStatement(payload, fileName, accountHint);
  }

  const text = String(payload || '');
  if (extension === '.csv') return parseCsvStatement(text, fileName, accountHint);
  if (extension === '.qif') return parseQifStatement(text, fileName, accountHint);
  if (extension === '.ofx') return parseOfxStatement(text, fileName, accountHint);
  if (extension === '.json') return parseJsonStatement(text, fileName, accountHint);
  return rejectedImport('Unsupported file type. Use PDF, CSV, QIF, OFX or JSON.');
}

export function parsePayslipText(text, fileName = 'Payslip.pdf') {
  const normal = normaliseWhitespace(text);
  const gross = findMoney(normal, /Gross Pay PTD\s+([\d,]+\.\d{2})/i);
  const taxable = findMoney(normal, /Taxable Pay PTD\s+([\d,]+\.\d{2})/i);
  const niable = findMoney(normal, /NIable Pay PTD\s+([\d,]+\.\d{2})/i);
  const net = findMoney(normal, /Net Pay\s+([\d,]+\.\d{2})/i) || findMoney(normal, /Split Amount[\s\S]{0,160}?([\d,]+\.\d{2})\s+BACS/i);
  const totalDeductions = findMoney(normal, /Total\s+([\d,]+\.\d{2})\s+Net Pay/i);
  const annualSalary = findMoney(normal, /Annual Salary\s+([\d,]+\.\d{2})/i);
  const payDate = firstDate(normal, /\b(\d{2}\/\d{2}\/\d{2})\b/);
  const periodMatch = normal.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(20\d{2})\b/i);
  const period = periodMatch ? `${periodMatch[2]}-${MONTHS[periodMatch[1].slice(0, 3).toLowerCase()]}` : (payDate ? payDate.slice(0, 7) : '');

  const earnings = namedAmounts(normal, [
    'Basic Pay Arrears', 'GPD Offset Taxable', 'GPD Taxable', 'Perm AEA', 'Temp AEA', 'AEA Arrears', 'LSA', 'Basic Pay'
  ], 'earning');
  const deductions = namedAmounts(normal, [
    'Service Charity Monthly\\(RN CHARITIES\\)', 'PAL PA Insurance', 'CILOCT Single', 'NI A', 'PAYE'
  ], 'deduction').map((entry) => ({ ...entry, name: entry.name.replace(/\\/g, '').replace(/\(|\)/g, (char) => char) }));

  const warnings = [];
  const rejected = [];
  if (!period || !gross || !net) rejected.push({ row: 1, reason: 'Could not find the pay period, gross pay or net pay.' });
  const earningsTotal = roundMoney(earnings.reduce((sum, item) => sum + item.amount, 0));
  const deductionsTotal = roundMoney(deductions.reduce((sum, item) => sum + item.amount, 0));
  if (gross && Math.abs(earningsTotal - gross) > 0.02) warnings.push(`Earnings lines total £${earningsTotal.toFixed(2)}, not gross pay £${gross.toFixed(2)}.`);
  if (totalDeductions && Math.abs(deductionsTotal - totalDeductions) > 0.02) warnings.push(`Deduction lines total £${deductionsTotal.toFixed(2)}, not £${totalDeductions.toFixed(2)}.`);
  if (gross && net && totalDeductions && Math.abs(roundMoney(gross - totalDeductions) - net) > 0.02) warnings.push('Gross pay less deductions does not reconcile to net pay.');

  const payslip = {
    id: stableId('payslip', fileName, period, gross, net),
    period,
    payDate,
    annualSalary,
    grossPay: gross,
    taxablePay: taxable,
    niablePay: niable,
    totalDeductions: totalDeductions || deductionsTotal,
    netPay: net,
    earnings,
    deductions,
    notes: '',
    source: fileName
  };

  return {
    kind: 'payslip',
    records: rejected.length ? [] : [payslip],
    rejected,
    warnings,
    summary: { period, gross, deductions: totalDeductions || deductionsTotal, net, earningsTotal },
    reconciled: !rejected.length && !warnings.length
  };
}

export function parseCsvStatement(text, fileName = 'statement.csv', accountHint = '') {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return rejectedImport('The CSV contains no transaction rows.');
  const headers = rows[0].map((value) => normaliseHeader(value));
  const indices = {
    date: findHeader(headers, ['date', 'transaction date', 'posted date', 'effective date']),
    description: findHeader(headers, ['description', 'details', 'merchant', 'payee', 'transaction']),
    debit: findHeader(headers, ['debit', 'money out', 'withdrawal', 'paid out']),
    credit: findHeader(headers, ['credit', 'money in', 'deposit', 'paid in']),
    amount: findHeader(headers, ['amount', 'value']),
    balance: findHeader(headers, ['balance', 'running balance']),
    type: findHeader(headers, ['type', 'transaction type'])
  };
  if (indices.date < 0 || indices.description < 0 || (indices.amount < 0 && indices.debit < 0 && indices.credit < 0)) {
    return rejectedImport('Required CSV columns are missing. Map Date, Description and either Amount or Debit/Credit.');
  }

  const rejected = [];
  const records = [];
  rows.slice(1).forEach((row, offset) => {
    if (!row.some((cell) => String(cell).trim())) return;
    const date = parseDate(row[indices.date]);
    const description = String(row[indices.description] || '').trim();
    const debit = indices.debit >= 0 ? parseMoney(row[indices.debit]) : null;
    const credit = indices.credit >= 0 ? parseMoney(row[indices.credit]) : null;
    const signedAmount = indices.amount >= 0 ? parseMoney(row[indices.amount]) : null;
    if (!date) return rejected.push({ row: offset + 2, reason: 'Invalid or ambiguous date.' });
    if (!description) return rejected.push({ row: offset + 2, reason: 'Missing description.' });

    let incoming = credit && credit > 0 ? credit : 0;
    let outgoing = debit && debit > 0 ? debit : 0;
    if (!incoming && !outgoing && signedAmount !== null && signedAmount !== 0) {
      const rawType = normaliseHeader(indices.type >= 0 ? row[indices.type] : '');
      const positiveIsDebit = rawType.includes('debit') || rawType.includes('withdrawal');
      if (signedAmount < 0 || positiveIsDebit) outgoing = Math.abs(signedAmount);
      else incoming = signedAmount;
    }
    if (!incoming && !outgoing) return rejected.push({ row: offset + 2, reason: 'Missing or zero amount.' });
    records.push(makeTransaction({ accountHint, date, description, incoming, outgoing, balance: indices.balance >= 0 ? parseMoney(row[indices.balance]) : null, source: fileName, sourceRow: offset + 2 }));
  });
  return statementResult(records, rejected, [], accountHint, fileName);
}

export function parseQifStatement(text, fileName = 'statement.qif', accountHint = '') {
  const blocks = text.split(/^\^\s*$/m);
  const records = [];
  const rejected = [];
  blocks.forEach((block, index) => {
    const fields = Object.fromEntries(block.split(/\r?\n/).filter(Boolean).map((line) => [line[0], line.slice(1).trim()]));
    if (!fields.D && !fields.T) return;
    const date = parseDate(fields.D);
    const amount = parseMoney(fields.T);
    if (!date || amount === null || amount === 0) return rejected.push({ row: index + 1, reason: !date ? 'Invalid QIF date.' : 'Invalid QIF amount.' });
    records.push(makeTransaction({ accountHint, date, description: fields.P || fields.M || 'QIF transaction', incoming: amount > 0 ? amount : 0, outgoing: amount < 0 ? Math.abs(amount) : 0, source: fileName, sourceRow: index + 1 }));
  });
  return statementResult(records, rejected, [], accountHint, fileName);
}

export function parseOfxStatement(text, fileName = 'statement.ofx', accountHint = '') {
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi) || [];
  const records = [];
  const rejected = [];
  blocks.forEach((block, index) => {
    const date = parseDate(tag(block, 'DTPOSTED'));
    const amount = parseMoney(tag(block, 'TRNAMT'));
    const description = tag(block, 'NAME') || tag(block, 'MEMO') || 'OFX transaction';
    if (!date || amount === null || amount === 0) return rejected.push({ row: index + 1, reason: !date ? 'Invalid OFX date.' : 'Invalid OFX amount.' });
    records.push(makeTransaction({ accountHint, date, description, incoming: amount > 0 ? amount : 0, outgoing: amount < 0 ? Math.abs(amount) : 0, source: fileName, sourceRow: index + 1, sourceId: tag(block, 'FITID') }));
  });
  return statementResult(records, rejected, [], accountHint, fileName);
}

function parseJsonStatement(text, fileName, accountHint) {
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed.transactions;
    if (!Array.isArray(entries)) return rejectedImport('JSON must contain a transactions array.');
    const records = [];
    const rejected = [];
    entries.forEach((entry, index) => {
      const date = parseDate(entry.date);
      const incoming = parseMoney(entry.incoming) || (entry.type === 'income' ? Math.abs(parseMoney(entry.amount) || 0) : 0);
      const outgoing = parseMoney(entry.outgoing) || (entry.type === 'expense' ? Math.abs(parseMoney(entry.amount) || 0) : 0);
      if (!date || (!incoming && !outgoing)) return rejected.push({ row: index + 1, reason: !date ? 'Invalid JSON date.' : 'Missing JSON amount.' });
      records.push(makeTransaction({ ...entry, accountHint: entry.accountId || accountHint, date, incoming, outgoing, source: fileName, sourceRow: index + 1 }));
    });
    return statementResult(records, rejected, [], accountHint, fileName);
  } catch {
    return rejectedImport('The JSON file is invalid.');
  }
}

function parsePdfStatement(document, fileName, accountHint) {
  const institution = detectInstitution(document.text);
  if (institution === 'monzo') return parseMonzoPdf(document, fileName, accountHint || 'Monzo');
  if (institution === 'halifax') return parseHalifaxPdf(document, fileName, accountHint || 'Halifax');
  if (institution === 'nationwide') return parseNationwidePdf(document, fileName, accountHint || 'Nationwide');
  return rejectedImport('This PDF layout is not recognised. Export CSV, QIF or OFX, or choose the account manually.');
}

function parseMonzoPdf(document, fileName, accountHint) {
  const records = [];
  for (const page of document.pages) {
    for (const line of page.lines) {
      const dateItem = line.items.find((item) => /^\d{2}\/\d{2}\/\d{4}$/.test(item.text));
      const monies = line.items.filter((item) => MONEY_PATTERN.test(item.text.replace(/\s/g, ''))).map((item) => ({ ...item, value: parseMoney(item.text) }));
      if (!dateItem || monies.length < 2) continue;
      const amountItem = monies[monies.length - 2];
      const balanceItem = monies[monies.length - 1];
      const description = line.items.filter((item) => item.x > dateItem.x && item.x < amountItem.x).map((item) => item.text).join(' ');
      const amount = amountItem.value;
      records.push(makeTransaction({ accountHint, date: parseDate(dateItem.text), description, incoming: amount > 0 ? amount : 0, outgoing: amount < 0 ? Math.abs(amount) : 0, balance: balanceItem.value, source: fileName, sourceRow: records.length + 1 }));
    }
  }
  return reconcilePdf(records, document.text, accountHint, fileName, {
    closing: /Personal Account balance[\s\S]{0,80}?(-?£?[\d,]+\.\d{2})/i
  });
}

function parseHalifaxPdf(document, fileName, accountHint) {
  const records = [];
  for (const page of document.pages) {
    for (const line of page.lines) {
      const dateItem = line.items.find((item) => /^\d{2} [A-Z][a-z]{2} \d{2}$/.test(item.text));
      const typeItem = line.items.find((item) => /^(FPI|FPO|TFR|CHG|DEB|DEP|DD|SO|BGC|ATM|CD|BP)$/i.test(item.text));
      const moneyItems = line.items.filter((item) => MONEY_PATTERN.test(item.text.replace(/\s/g, '')));
      if (!dateItem || !typeItem || moneyItems.length < 2) continue;
      const balanceItem = moneyItems[moneyItems.length - 1];
      const amountItem = moneyItems[moneyItems.length - 2];
      const isIncome = /^(FPI|BGC|DEP)$/i.test(typeItem.text);
      const description = line.items.filter((item) => item.x > dateItem.x && item.x < typeItem.x && item.text !== '.').map((item) => item.text).join(' ');
      records.push(makeTransaction({ accountHint, date: parseDate(dateItem.text), description, incoming: isIncome ? Math.abs(parseMoney(amountItem.text)) : 0, outgoing: isIncome ? 0 : Math.abs(parseMoney(amountItem.text)), balance: parseMoney(balanceItem.text), bankType: typeItem.text, source: fileName, sourceRow: records.length + 1 }));
    }
  }
  resolveDirectionsFromRunningBalances(records);
  return reconcilePdf(records, document.text, accountHint, fileName, {
    opening: /Balance on \d{2} [A-Za-z]+ 20\d{2}[\s\S]{0,80}?(-?£?[\d,]+\.\d{2})/i,
    closing: /Balance on \d{2} [A-Za-z]+ 20\d{2}[\s\S]{0,80}?(-?£?[\d,]+\.\d{2})/gi
  });
}

function resolveDirectionsFromRunningBalances(records) {
  records.sort((left, right) => left.date.localeCompare(right.date) || Number(left.sourceRow || 0) - Number(right.sourceRow || 0));
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1].runningBalance;
    const current = records[index].runningBalance;
    if (previous === null || current === null) continue;
    const amount = records[index].incoming || records[index].outgoing;
    const movement = roundMoney(current - previous);
    if (Math.abs(Math.abs(movement) - amount) > 0.02) continue;
    records[index].incoming = movement > 0 ? amount : 0;
    records[index].outgoing = movement < 0 ? amount : 0;
    records[index].category = movement > 0 ? 'Income / refund' : 'Other / review';
  }
}

function parseNationwidePdf(document, fileName, accountHint) {
  const records = [];
  let currentDate = '';
  for (const page of document.pages) {
    const width = page.width;
    let tableActive = false;
    for (const line of page.lines) {
      if (/Date\s+Description[\s\S]*£ Out[\s\S]*£ In/i.test(line.text)) { tableActive = true; continue; }
      if (/Summary box for your|This information doesn't replace your Terms/i.test(line.text)) { tableActive = false; continue; }
      if (!tableActive) continue;
      const dateItem = line.items.find((item) => /^(\d{2} [A-Z][a-z]{2}|\d{1,2} [A-Z][a-z]{2})$/.test(item.text));
      if (dateItem) currentDate = parseDate(`${dateItem.text} ${statementYear(document.text)}`);
      const outItems = line.items.filter((item) => item.x >= width * 0.44 && item.x < width * 0.54 && MONEY_PATTERN.test(item.text.replace(/\s/g, '')));
      const inItems = line.items.filter((item) => item.x >= width * 0.54 && item.x < width * 0.63 && MONEY_PATTERN.test(item.text.replace(/\s/g, '')));
      const balanceItems = line.items.filter((item) => item.x >= width * 0.63 && item.x < width * 0.74 && MONEY_PATTERN.test(item.text.replace(/\s/g, '')));
      const amountItem = outItems[0] || inItems[0];
      const description = line.items.filter((item) => item.x > width * 0.12 && item.x < width * 0.44 && item !== dateItem).map((item) => item.text).join(' ').trim();
      if (amountItem && currentDate && description && !/description|transactions|statement/i.test(description)) {
        records.push(makeTransaction({ accountHint, date: currentDate, description, incoming: inItems[0] ? Math.abs(parseMoney(inItems[0].text)) : 0, outgoing: outItems[0] ? Math.abs(parseMoney(outItems[0].text)) : 0, balance: balanceItems[0] ? parseMoney(balanceItems[0].text) : null, source: fileName, sourceRow: records.length + 1 }));
      } else if (!amountItem && records.length && description && !/balance from statement|nationwide building society|head office|authorised by|transactions|continued|date|description/i.test(description)) {
        records[records.length - 1].description = `${records[records.length - 1].description} | ${description}`;
      }
    }
  }
  return reconcilePdf(records, document.text, accountHint, fileName, {
    opening: /Start balance\s+£?(-?[\d,]+\.\d{2})/i,
    closing: /End balance\s+£?(-?[\d,]+\.\d{2})/i
  });
}

function reconcilePdf(records, text, accountHint, fileName, patterns) {
  records.sort((left, right) => left.date.localeCompare(right.date) || Number(left.sourceRow || 0) - Number(right.sourceRow || 0));
  const warnings = [];
  let opening = findMoney(text, patterns.opening);
  let closing;
  if (patterns.closing?.global) {
    const matches = [...text.matchAll(patterns.closing)];
    closing = matches.length ? parseMoney(matches[matches.length - 1][1]) : null;
  } else {
    closing = findMoney(text, patterns.closing);
  }
  const incoming = roundMoney(records.reduce((sum, item) => sum + item.incoming, 0));
  const outgoing = roundMoney(records.reduce((sum, item) => sum + item.outgoing, 0));
  if (records.length && records[0].runningBalance !== null) opening = roundMoney(records[0].runningBalance - records[0].incoming + records[0].outgoing);
  if (records.length && records[records.length - 1].runningBalance !== null) closing = records[records.length - 1].runningBalance;
  const expectedClosing = opening === null ? null : roundMoney(opening + incoming - outgoing);
  const reconciled = opening !== null && closing !== null && Math.abs(expectedClosing - closing) <= 0.02;
  if (!records.length) warnings.push('No transaction rows could be read from this PDF.');
  if (records.length && !reconciled) warnings.push('The parsed transactions do not reconcile to the statement balances. Review the preview before importing.');
  return {
    kind: 'statement', records, rejected: [], warnings, accountHint, source: fileName,
    summary: { incoming, outgoing, openingBalance: opening, closingBalance: closing, expectedClosing }, reconciled
  };
}

function statementResult(records, rejected, warnings, accountHint, fileName) {
  return {
    kind: 'statement', records, rejected, warnings, accountHint, source: fileName,
    summary: {
      incoming: roundMoney(records.reduce((sum, item) => sum + item.incoming, 0)),
      outgoing: roundMoney(records.reduce((sum, item) => sum + item.outgoing, 0)),
      count: records.length
    },
    reconciled: rejected.length === 0 && records.length > 0
  };
}

function makeTransaction(input) {
  const incoming = roundMoney(Math.abs(Number(input.incoming || 0)));
  const outgoing = roundMoney(Math.abs(Number(input.outgoing || 0)));
  const date = parseDate(input.date);
  const description = String(input.description || 'Imported payment').trim();
  const classified = classifyTransaction(description, incoming, outgoing);
  return {
    id: stableId('transaction', input.accountHint, date, description, incoming, outgoing, input.sourceId || input.sourceRow),
    accountId: input.accountHint || '', date, budgetMonth: date?.slice(0, 7) || '',
    description, userDescription: input.userDescription || '', notes: input.notes || '',
    incoming, outgoing, runningBalance: input.balance ?? input.runningBalance ?? null,
    category: input.category || classified.category,
    transferStatus: input.transferStatus || classified.transferStatus, recurring: input.recurring ?? classified.recurring, cleared: true,
    source: input.source || 'manual', sourceRow: input.sourceRow || null, bankType: input.bankType || ''
  };
}

function classifyTransaction(description, incoming, outgoing) {
  const text = description.toLowerCase();
  if (incoming > 0) return { category: /pay office|salary|payroll|wages/.test(text) ? 'Income - pay' : 'Income / refund', transferStatus: /own account|internal transfer|account transfer/.test(text) ? 'possible' : 'no', recurring: false };
  const rules = [
    [/daily od int|overdraft fees|foreign currency transaction fee/, 'Overdraft interest & fees'],
    [/loan payment|credit card payment|debt payment|finance payment/, 'Debt payment'],
    [/insurance|assurance/, 'Insurance'],
    [/shell|esso|bp |petrol|diesel|filling station|service station/, 'Fuel'],
    [/tesco|sainsburys|morrisons|co-op|asda|costcutter|grocer/, 'Groceries'],
    [/mcdonald|burger king|restaurant|cafe|coffee|catering|takeaway/, 'Eating out'],
    [/apple\.com|google play|spotify|netflix|microsoft|amazon prime|subscription/, 'Subscriptions & software'],
    [/garage|mot |tyre|kwik fit|halfords|car repair|dvla/, 'Car / maintenance'],
    [/parking|uber|taxi|trainline|rail|bus fare|toll/, 'Transport / parking'],
    [/savings|investment contribution/, 'Savings']
  ];
  const category = rules.find(([pattern]) => pattern.test(text))?.[1] || 'Other / review';
  return { category, transferStatus: /own account|internal transfer|account transfer/.test(text) ? 'possible' : 'no', recurring: /direct debit|standing order|recurring/.test(text) };
}

function namedAmounts(text, labels, type) {
  const found = [];
  for (const rawLabel of labels) {
    const labelPattern = rawLabel.replace(/ /g, '\\s+');
    const match = text.match(new RegExp(`${labelPattern}\\s+(-?[\\d,]+\\.\\d{2})`, 'i'));
    if (match) found.push({ id: stableId(type, rawLabel), name: rawLabel.replace(/\\/g, ''), amount: parseMoney(match[1]), type, notes: '' });
  }
  return found;
}

function inferDocumentKind(fileName, text) {
  return /pay slip|payslip|statement of salary|JPA E017/i.test(`${fileName} ${text}`) ? 'payslip' : 'statement';
}

function detectInstitution(text) {
  if (/Monzo Bank Limited|Personal Account statement/i.test(text)) return 'monzo';
  if (/logo, Halifax|Halifax plc|www\.halifax\.co\.uk/i.test(text)) return 'halifax';
  if (/Nationwide Building Society|Your FlexAccount/i.test(text)) return 'nationwide';
  return '';
}

function statementYear(text) {
  return text.match(/Statement date:\s*\d{1,2} [A-Za-z]+ (20\d{2})/i)?.[1] || text.match(/\b(20\d{2})\b/)?.[1] || new Date().getFullYear();
}

function findMoney(text, pattern) {
  if (!pattern) return null;
  const match = text.match(pattern);
  return match ? parseMoney(match[1]) : null;
}

function firstDate(text, pattern) {
  const match = text.match(pattern);
  return match ? parseDate(match[1]) : '';
}

export function parseDate(value) {
  if (!value) return '';
  const text = String(value).trim();
  let match = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (match) return validIso(match[1], match[2], match[3]);
  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return validIso(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (match) return validIso(match[3].length === 2 ? `20${match[3]}` : match[3], match[2], match[1]);
  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2}|\d{4})$/);
  if (match) return validIso(match[3].length === 2 ? `20${match[3]}` : match[3], MONTHS[match[2].toLowerCase()], match[1]);
  return '';
}

function validIso(year, month, day) {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? '' : iso;
}

export function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim().replace(/\s/g, '').replace(/£/g, '').replace(/,/g, '');
  const parenthesised = /^\(.+\)$/.test(text);
  text = text.replace(/[()]/g, '').replace(/^\+/, '');
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return parenthesised ? -number : number;
}

function tag(block, name) {
  return block.match(new RegExp(`<${name}>([^<\\r\\n]+)`, 'i'))?.[1]?.trim() || '';
}

function findHeader(headers, candidates) {
  return headers.findIndex((header) => candidates.some((candidate) => header === candidate || header.includes(candidate)));
}

function normaliseHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normaliseWhitespace(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r/g, '');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(field); field = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function stableId(...parts) {
  return crypto.createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex').slice(0, 24);
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function rejectedImport(reason) {
  return { kind: 'unknown', records: [], rejected: [{ row: 0, reason }], warnings: [], summary: {}, reconciled: false };
}
