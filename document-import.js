import crypto from 'node:crypto';
import path from 'node:path';
import { normaliseCreditAccountType, normaliseCreditStatus, normaliseLender } from './credit-report-intelligence.js';

const MONEY_PATTERN = /^(?:[-+]?\s*(?:£|GBP)?\s*[\d,]+\.\d{2}|\((?:£|GBP)?\s*[\d,]+\.\d{2}\))(?:\s*(?:CR|DR))?$/i;
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const RECONCILIATION_TOLERANCE = 0.01;

export function parseImportedDocument(fileName, payload, requestedKind = 'auto', accountHint = '') {
  const extension = path.extname(fileName).toLowerCase();
  const kind = requestedKind === 'auto' ? inferDocumentKind(fileName, payload?.text || String(payload || '')) : requestedKind;

  if (kind === 'payslip') {
    return parsePayslipText(payload.text || String(payload || ''), fileName);
  }

  if (kind === 'credit-report') {
    if (extension !== '.pdf') return rejectedImport('Credit reports must be imported as PDF files.');
    return parseCreditReportText(payload.text || String(payload || ''), fileName);
  }

  if (extension === '.pdf') {
    return parsePdfStatement(payload, fileName, accountHint);
  }

  const text = String(payload || '');
  if (['.csv', '.tsv', '.txt'].includes(extension)) return parseCsvStatement(text, fileName, accountHint);
  if (extension === '.qif') return parseQifStatement(text, fileName, accountHint);
  if (['.ofx', '.qfx'].includes(extension)) return parseOfxStatement(text, fileName, accountHint);
  if (extension === '.json') return parseJsonStatement(text, fileName, accountHint);
  return rejectedImport('Unsupported file type. Use PDF, CSV, TSV, QIF, OFX, QFX or JSON.');
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

export function parseCreditReportText(text, fileName = 'credit-report.pdf') {
  const sourceText = String(text || '');
  const provider = detectCreditReportProvider(sourceText);
  const reportDate = findLabelledDate(sourceText, /(?:report date|date of report|report as at|report correct (?:on|at)|generated (?:on|at)|report generated)/i);
  const scoreMatch = sourceText.match(/(?:credit\s+score|your\s+score)(?:\s+is|\s*:)?\s*(\d{1,4})(?:\s*(?:\/|out of)\s*(\d{2,4}))?/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  const scoreMaximum = scoreMatch?.[2] ? Number(scoreMatch[2]) : null;
  const accounts = parseCreditReportAccounts(sourceText, fileName).map((account) => ({
    ...account,
    sourceProvider: provider || '',
    sourceReportDate: reportDate,
    reportedDate: account.updatedDate || reportDate,
    confidence: account.lender && account.normalisedAccountType !== 'unknown' && account.currentBalance !== null ? 'high' : 'review'
  }));
  const warnings = [];
  if (!provider) warnings.push('The credit-report provider was not identified automatically.');
  if (!reportDate) warnings.push('The report date was not identified automatically.');
  if (!accounts.length) warnings.push('No structured account entries were detected. The encrypted report is still available for manual review.');

  const report = {
    id: stableId('credit-report', fileName, provider, reportDate, score, accounts.map((account) => account.id).join(',')),
    provider: provider || 'Unknown provider',
    reportDate,
    score,
    scoreMinimum: scoreMaximum ? 0 : null,
    scoreMaximum,
    sourceFormat: 'pdf-text',
    accounts,
    notes: '',
    source: fileName
  };
  return {
    kind: 'credit-report',
    records: [report],
    rejected: [],
    warnings,
    summary: { provider: report.provider, reportDate, score, scoreMinimum: report.scoreMinimum, scoreMaximum, accountCount: accounts.length },
    reconciled: Boolean(provider && reportDate && accounts.length)
  };
}

function detectCreditReportProvider(text) {
  if (/\bExperian\b/i.test(text)) return 'Experian';
  if (/\bClearScore\b/i.test(text)) return 'ClearScore';
  if (/\bCredit Karma\b/i.test(text)) return 'Credit Karma';
  if (/\bTotallyMoney\b/i.test(text)) return 'TotallyMoney';
  if (/\bTransUnion\b/i.test(text)) return 'TransUnion';
  if (/\bEquifax\b/i.test(text)) return 'Equifax';
  return '';
}

function findLabelledDate(text, labelPattern) {
  const datePattern = '(\\d{1,2}[/-]\\d{1,2}[/-](?:\\d{4}|\\d{2})|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+(?:\\d{4}|\\d{2})|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})';
  const match = String(text || '').match(new RegExp(`${labelPattern.source}[\\s:.-]{0,12}${datePattern}`, 'i'));
  return match ? parseDate(match[1]) : '';
}

function parseCreditReportAccounts(text, fileName) {
  const lines = String(text || '').split(/\r?\n/).map((line) => normaliseWhitespace(line).trim()).filter(Boolean);
  const lenderPattern = /^(?:lender|creditor|account provider|provider|company|organisation|organization|account name|name of organisation)\s*:?\s*(.*)$/i;
  const starts = [];
  lines.forEach((line, index) => {
    const match = line.match(lenderPattern);
    if (match) starts.push({ index, inlineValue: match[1].trim() });
  });

  const accounts = [];
  starts.forEach((start, position) => {
    const end = starts[position + 1]?.index ?? Math.min(lines.length, start.index + 50);
    const block = lines.slice(start.index, end);
    const lender = start.inlineValue || nextUnlabelledValue(lines, start.index);
    const accountType = labelledText(block, /^(?:account type|type of account|product type)\s*:?\s*(.*)$/i);
    const balanceText = labelledText(block, /^(?:current balance|outstanding balance|amount owed|balance)\s*:?\s*(.*)$/i);
    const limitText = labelledText(block, /^(?:credit limit|account limit)\s*:?\s*(.*)$/i);
    const status = labelledText(block, /^(?:account status|payment status|status)\s*:?\s*(.*)$/i);
    const openedText = labelledText(block, /^(?:opened|opening date|start date|account opened)\s*:?\s*(.*)$/i);
    const referenceText = labelledText(block, /^(?:account number|account reference|reference number|reference)\s*:?\s*(.*)$/i);
    const monthlyPaymentText = labelledText(block, /^(?:monthly payment|regular payment|agreed instalment|payment amount)\s*:?\s*(.*)$/i);
    const minimumPaymentText = labelledText(block, /^(?:minimum payment|min payment)\s*:?\s*(.*)$/i);
    const aprText = labelledText(block, /^(?:apr|annual percentage rate|interest rate)\s*:?\s*(.*)$/i);
    const originalBalanceText = labelledText(block, /^(?:original balance|opening balance|original amount|loan amount)\s*:?\s*(.*)$/i);
    const defaultDateText = labelledText(block, /^(?:default date|date defaulted)\s*:?\s*(.*)$/i);
    const settledDateText = labelledText(block, /^(?:settlement date|settled date|date settled|satisfied date)\s*:?\s*(.*)$/i);
    const closedDateText = labelledText(block, /^(?:closure date|closed date|date closed)\s*:?\s*(.*)$/i);
    const updatedText = labelledText(block, /^(?:last updated|updated on|balance updated|reported on)\s*:?\s*(.*)$/i);
    const arrearsText = labelledText(block, /^(?:arrears balance|arrears amount|amount in arrears)\s*:?\s*(.*)$/i);
    const missedPaymentsText = labelledText(block, /^(?:missed payments|payments missed|months in arrears)\s*:?\s*(.*)$/i);
    const arrangementText = labelledText(block, /^(?:payment arrangement|arrangement to pay|special arrangement|payment plan)\s*:?\s*(.*)$/i);
    const arrangementPaymentText = labelledText(block, /^(?:arrangement payment|agreed payment|reduced payment)\s*:?\s*(.*)$/i);
    const interestTreatmentText = labelledText(block, /^(?:interest treatment|interest status|interest frozen|charges frozen)\s*:?\s*(.*)$/i);
    const responsibilityText = labelledText(block, /^(?:responsibility|account ownership|liability)\s*:?\s*(.*)$/i);
    const disputeText = labelledText(block, /^(?:dispute status|account disputed|disputed)\s*:?\s*(.*)$/i);
    const originalLender = labelledText(block, /^(?:original lender|original creditor)\s*:?\s*(.*)$/i);
    const currentBalance = moneyFromText(balanceText);
    const creditLimit = moneyFromText(limitText);
    const monthlyPayment = moneyFromText(monthlyPaymentText);
    const minimumPayment = moneyFromText(minimumPaymentText);
    const contractualPayment = monthlyPayment ?? minimumPayment;
    const originalBalance = moneyFromText(originalBalanceText);
    const apr = percentageFromText(aprText);
    const openedDate = dateFromText(openedText);
    const defaultDate = dateFromText(defaultDateText);
    const settledDate = dateFromText(settledDateText);
    const closedDate = dateFromText(closedDateText);
    const updatedDate = dateFromText(updatedText);
    const accountReference = accountReferenceFromText(referenceText);
    const normalisedAccountType = normaliseCreditAccountType(accountType);
    let normalisedStatus = normaliseCreditStatus(status);
    if (normalisedStatus === 'unknown' && defaultDate) normalisedStatus = 'defaulted';
    if (normalisedStatus === 'unknown' && settledDate) normalisedStatus = 'settled';
    if (normalisedStatus === 'unknown' && closedDate) normalisedStatus = 'closed';
    if (currentBalance !== null && creditLimit !== null && currentBalance > creditLimit && !['defaulted', 'arrears'].includes(normalisedStatus)) normalisedStatus = 'over_limit';
    const lifecycleStatus = normalisedStatus === 'settled' ? 'settled' : normalisedStatus === 'closed' ? 'closed' : normalisedStatus === 'unknown' ? 'unknown' : 'active';
    const arrangementStatus = arrangementStatusFromText(arrangementText || status);
    const arrearsAmount = moneyFromText(arrearsText);
    const missedPayments = integerFromText(missedPaymentsText);
    const arrangementPayment = moneyFromText(arrangementPaymentText);
    const interestFrozen = explicitPositive(interestTreatmentText, /frozen|suspended|no interest|no charges/i);
    const jointAccount = explicitPositive(responsibilityText, /joint|shared/i);
    const disputed = explicitPositive(disputeText || status, /disputed|in dispute/i);
    if (!lender || (!accountType && currentBalance === null && creditLimit === null && contractualPayment === null && originalBalance === null && apr === null && !status && !openedDate && !defaultDate)) return;
    accounts.push({
      id: stableId('credit-report-account', fileName, lender, accountType, currentBalance, creditLimit, contractualPayment, originalBalance, apr, status, openedDate, defaultDate, accountReference),
      lender,
      normalisedLender: normaliseLender(lender),
      accountType,
      normalisedAccountType,
      currentBalance,
      creditLimit,
      contractualPayment,
      monthlyPayment,
      minimumPayment,
      originalBalance,
      apr,
      status,
      normalisedStatus,
      lifecycleStatus,
      openedDate,
      defaultDate,
      settledDate,
      closedDate,
      updatedDate,
      accountReference,
      arrearsAmount,
      missedPayments,
      arrangementStatus,
      arrangementPayment,
      interestFrozen,
      jointAccount,
      disputed,
      originalLender,
      notes: ''
    });
  });
  return accounts;
}

function labelledText(lines, pattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    return match[1]?.trim() || nextUnlabelledValue(lines, index);
  }
  return '';
}

function nextUnlabelledValue(lines, index) {
  const next = String(lines[index + 1] || '').trim();
  return next && !/^[A-Za-z][A-Za-z ]{1,30}\s*:/.test(next) ? next : '';
}

function moneyFromText(value) {
  const match = String(value || '').match(/(?:^|[^A-Za-z0-9.,])((?:[-+]?\s*(?:£|GBP)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?|\((?:£|GBP)?\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\))(?:\s*(?:CR|DR))?)(?![A-Za-z0-9.,])/i);
  return match ? parseMoney(match[1]) : null;
}

function percentageFromText(value) {
  const match = String(value || '').match(/(\d{1,3}(?:\.\d{1,3})?)\s*%/);
  return match ? Number(match[1]) / 100 : null;
}

function dateFromText(value) {
  const text = String(value || '');
  const match = text.match(/\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2})|\d{1,2}\s+[A-Za-z]{3,9}\s+(?:\d{4}|\d{2})|\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
  return match ? parseDate(match[0]) : '';
}

function accountReferenceFromText(value) {
  const compact = String(value || '').replace(/\s/g, '');
  const visible = compact.match(/([A-Za-z0-9]{4})$/)?.[1] || '';
  return visible ? `••••${visible.toUpperCase()}` : '';
}

function arrangementStatusFromText(value) {
  const text = normaliseWhitespace(value).toLowerCase();
  if (!text) return 'unknown';
  if (/\b(?:yes|confirmed|active|arrangement to pay|payment plan|reduced payment)\b/.test(text)) return 'confirmed';
  if (/\b(?:no|none|not arranged|no arrangement)\b/.test(text)) return 'none';
  return 'unknown';
}

function integerFromText(value) {
  const match = String(value || '').match(/\b(\d{1,2})\b/);
  return match ? Number(match[1]) : null;
}

function explicitPositive(value, pattern) {
  const text = String(value || '');
  if (!text || /\b(?:no|not|none|false)\b/i.test(text)) return false;
  return /\b(?:yes|true|confirmed|active)\b/i.test(text) || pattern.test(text);
}

export function parseCsvStatement(text, fileName = 'statement.csv', accountHint = '') {
  const rows = parseDelimitedRows(text);
  if (rows.length < 2) return rejectedImport('The CSV contains no transaction rows.');
  const headerIndex = findStatementHeaderRow(rows);
  if (headerIndex < 0) return rejectedImport('Required columns are missing. Include Date, Description and either Amount or Money In/Money Out.');
  const headers = rows[headerIndex].map((value) => normaliseHeader(value));
  const indices = {
    date: findHeader(headers, ['date', 'transaction date', 'posted date', 'posting date', 'booking date', 'completed date', 'effective date', 'value date']),
    postingDate: findHeader(headers, ['posting date', 'posted date', 'booking date', 'completed date']),
    valueDate: findHeader(headers, ['value date', 'effective date']),
    description: findHeader(headers, ['description', 'transaction description', 'details', 'merchant', 'payee', 'counter party', 'counterparty', 'narrative', 'reference', 'memo', 'name']),
    debit: findHeader(headers, ['debit', 'debit amount', 'money out', 'withdrawal', 'paid out', 'spent']),
    credit: findHeader(headers, ['credit', 'credit amount', 'money in', 'deposit', 'paid in', 'received']),
    amount: findHeader(headers, ['amount', 'transaction amount', 'value']),
    balance: findHeader(headers, ['balance', 'running balance', 'account balance']),
    type: findHeader(headers, ['type', 'transaction type', 'debit credit', 'credit debit indicator', 'dr cr'])
  };

  const rejected = [];
  const records = [];
  rows.slice(headerIndex + 1).forEach((row, offset) => {
    if (!row.some((cell) => String(cell).trim())) return;
    const date = parseDate(row[indices.date]);
    const postingDate = indices.postingDate >= 0 ? parseDate(row[indices.postingDate]) : '';
    const valueDate = indices.valueDate >= 0 ? parseDate(row[indices.valueDate]) : '';
    const description = String(row[indices.description] || '').trim();
    const debit = indices.debit >= 0 ? parseMoney(row[indices.debit]) : null;
    const credit = indices.credit >= 0 ? parseMoney(row[indices.credit]) : null;
    const signedAmount = indices.amount >= 0 ? parseMoney(row[indices.amount]) : null;
    let incoming = credit && credit > 0 ? credit : 0;
    let outgoing = debit && debit > 0 ? debit : 0;
    if (!incoming && !outgoing && signedAmount !== null && signedAmount !== 0) {
      const direction = transactionDirection(indices.type >= 0 ? row[indices.type] : '');
      if (signedAmount < 0 || direction === 'outgoing') outgoing = Math.abs(signedAmount);
      else incoming = Math.abs(signedAmount);
    }
    const sourceRow = headerIndex + offset + 2;
    if (!date) return rejected.push({ row: sourceRow, reason: 'Invalid or ambiguous date.' });
    if (!description) return rejected.push({ row: sourceRow, reason: 'Missing description.' });
    if (!incoming && !outgoing) return rejected.push({ row: sourceRow, reason: 'Missing or zero amount.' });
    records.push(makeTransaction({ accountHint, date, postingDate, valueDate, description, incoming, outgoing, balance: indices.balance >= 0 ? parseMoney(row[indices.balance]) : null, bankType: indices.type >= 0 ? String(row[indices.type] || '').trim() : '', source: fileName, sourceRow }));
  });
  return statementResult(records, rejected, [], accountHint, fileName, statementMetadataFromText(text, records, { parserConfidence: 'structured-export' }));
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
  return statementResult(records, rejected, [], accountHint, fileName, statementMetadataFromText(text, records, { parserConfidence: 'structured-export' }));
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
    records.push(makeTransaction({ accountHint, date, description, incoming: amount > 0 ? amount : 0, outgoing: amount < 0 ? Math.abs(amount) : 0, source: fileName, sourceRow: index + 1, sourceId: tag(block, 'FITID'), reference: tag(block, 'REFNUM') || tag(block, 'MEMO') }));
  });
  const metadata = statementMetadataFromText(text, records, {
    institution: tag(text, 'ORG') || tag(text, 'BANKID'),
    accountReference: safeAccountReference(tag(text, 'ACCTID')),
    accountType: tag(text, 'ACCTTYPE'),
    currency: normaliseCurrency(tag(text, 'CURDEF')),
    statementStartDate: parseDate(tag(text, 'DTSTART')),
    statementEndDate: parseDate(tag(text, 'DTEND')),
    periodSource: tag(text, 'DTSTART') || tag(text, 'DTEND') ? 'explicit' : '',
    parserConfidence: 'structured-export'
  });
  return statementResult(records, rejected, [], accountHint, fileName, metadata);
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
    const metadata = statementMetadataFromText('', records, Array.isArray(parsed) ? {} : {
      institution: parsed.institution,
      accountReference: safeAccountReference(parsed.accountNumber || parsed.accountReference),
      accountType: parsed.accountType,
      currency: normaliseCurrency(parsed.currency),
      statementStartDate: parseDate(parsed.statementStartDate || parsed.startDate),
      statementEndDate: parseDate(parsed.statementEndDate || parsed.endDate),
      periodSource: parsed.statementStartDate || parsed.startDate || parsed.statementEndDate || parsed.endDate ? 'explicit' : '',
      parserConfidence: 'structured-export'
    });
    return statementResult(records, rejected, [], accountHint, fileName, metadata);
  } catch {
    return rejectedImport('The JSON file is invalid.');
  }
}

export function parsePdfStatement(document, fileName, accountHint) {
  const institution = detectInstitution(document.text);
  const knownParsers = {
    monzo: [parseMonzoPdf, 'Monzo'],
    halifax: [parseLbgPdf, 'Halifax'],
    lloyds: [parseLbgPdf, 'Lloyds'],
    'bank-of-scotland': [parseLbgPdf, 'Bank of Scotland'],
    nationwide: [parseNationwidePdf, 'Nationwide']
  };
  if (knownParsers[institution]) {
    const [parser, provider] = knownParsers[institution];
    const parsed = parser(document, fileName, accountHint || provider);
    if (parsed.records.length) return enrichPdfStatement(parsed, document.text, provider, 'provider-specific');
  }
  const generic = parseGenericPdfTable(document, fileName, accountHint || knownParsers[institution]?.[1] || '');
  if (generic.records.length) {
    generic.warnings.push('This statement used the conservative generic PDF table parser. Check the account and balance summary before importing.');
    return enrichPdfStatement(generic, document.text, knownParsers[institution]?.[1] || '', 'generic');
  }
  return rejectedImport('This PDF layout is not recognised. Try the bank\'s CSV, QIF, OFX or QFX export; the encrypted original has still been kept for review.');
}

function enrichPdfStatement(result, text, institution, parserConfidence) {
  const overdraftLimit = findMoney(text, /(?:arranged|agreed)\s+overdraft\s*(?:limit|facility|amount)?[\s:£]{0,20}([\d,]+\.\d{2})/i)
    ?? findMoney(text, /(?:overdraft limit|overdraft facility)[\s\S]{0,40}?£?([\d,]+\.\d{2})/i);
  const overdraftRateText = String(text || '').match(/(?:arranged overdraft|overdraft interest)[\s\S]{0,180}?(?:EAR|APR|annual interest rate)[\s:]*(\d{1,3}(?:\.\d{1,3})?)\s*%/i)?.[0] || '';
  const overdraftApr = percentageFromText(overdraftRateText);
  const metadata = statementMetadataFromText(text, result.records, { institution, parserConfidence });
  result.institution = institution;
  result.accountIdentity = metadata.accountIdentity;
  result.period = metadata.period;
  result.summary = { ...result.summary, ...metadata.summary, institution, overdraftLimit, overdraftApr };
  return result;
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

function parseLbgPdf(document, fileName, accountHint) {
  const records = [];
  for (const page of document.pages) {
    for (const line of page.lines) {
      const dateItem = line.items.find((item) => /^\d{1,2} [A-Z][a-z]{2} \d{2}$/.test(item.text));
      const typeItem = line.items.find((item) => /^(FPI|FPO|TFR|CHG|DEB|DEP|DD|SO|BGC|ATM|CD|BP|COR|CHQ|CPT|FEE|MPI|MPO|PAY)$/i.test(item.text));
      const moneyItems = line.items.filter((item) => MONEY_PATTERN.test(item.text.replace(/\s/g, '')));
      if (!dateItem || !typeItem || moneyItems.length < 2) continue;
      const balanceItem = moneyItems[moneyItems.length - 1];
      const amountItem = moneyItems[moneyItems.length - 2];
      const isIncome = /^(FPI|BGC|DEP|MPI)$/i.test(typeItem.text);
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

function parseGenericPdfTable(document, fileName, accountHint) {
  const records = [];
  for (const page of document.pages || []) {
    let columns = null;
    let currentDate = '';
    for (const line of page.lines || []) {
      const detectedColumns = detectPdfTableColumns(line);
      if (detectedColumns) {
        columns = detectedColumns;
        currentDate = '';
        continue;
      }
      if (!columns) continue;
      if (/terms and conditions|important information|how to complain|financial services compensation|summary box/i.test(line.text)) {
        columns = null;
        continue;
      }

      const dateItem = line.items.find((item) => parseDate(item.text));
      if (dateItem) currentDate = parseDate(dateItem.text);
      const money = {};
      for (const item of line.items) {
        if (!MONEY_PATTERN.test(String(item.text).replace(/\u00a0/g, ' ').trim())) continue;
        const column = nearestPdfColumn(item.x, columns, ['outgoing', 'incoming', 'amount', 'balance']);
        if (column && money[column] === undefined) money[column] = parseMoney(item.text);
      }

      const description = pdfColumnText(line, columns, 'description', dateItem);
      const bankType = pdfColumnText(line, columns, 'type', dateItem);
      const hasSplitAmount = money.outgoing !== undefined || money.incoming !== undefined;
      const hasSignedAmount = money.amount !== undefined;
      if (!hasSplitAmount && !hasSignedAmount) {
        if (!dateItem && description && records.length && !/continued|carried forward|brought forward/i.test(description)) {
          records[records.length - 1].description = `${records[records.length - 1].description} | ${description}`;
        }
        continue;
      }
      if (!currentDate || !description || /opening balance|closing balance|balance brought forward/i.test(description)) continue;

      let incoming = Math.abs(money.incoming || 0);
      let outgoing = Math.abs(money.outgoing || 0);
      if (!incoming && !outgoing && hasSignedAmount && money.amount) {
        const direction = transactionDirection(bankType);
        if (money.amount < 0 || direction === 'outgoing') outgoing = Math.abs(money.amount);
        else incoming = Math.abs(money.amount);
      }
      if (!incoming && !outgoing) continue;
      records.push(makeTransaction({
        accountHint,
        date: currentDate,
        description,
        incoming,
        outgoing,
        balance: money.balance ?? null,
        bankType,
        source: fileName,
        sourceRow: records.length + 1
      }));
    }
  }
  return reconcilePdf(records, document.text || '', accountHint, fileName, {
    opening: /(?:Opening|Start|Previous) balance\s*(?:£|GBP)?\s*(-?[\d,]+\.\d{2})/i,
    closing: /(?:Closing|End|New) balance\s*(?:£|GBP)?\s*(-?[\d,]+\.\d{2})/i
  });
}

function detectPdfTableColumns(line) {
  const spans = pdfHeaderSpans(line.items || []);
  const columns = {
    date: pdfHeaderPosition(spans, [/^(?:transaction |posting |value )?date$/]),
    description: pdfHeaderPosition(spans, [/^(?:transaction )?(?:description|details|narrative)$/, /^counter ?party$/]),
    type: pdfHeaderPosition(spans, [/^(?:transaction )?type$/, /^dr cr$/, /^debit credit$/]),
    outgoing: pdfHeaderPosition(spans, [/^(?:money|paid) out$/, /^debit(?: amount)?$/, /^withdrawals?$/]),
    incoming: pdfHeaderPosition(spans, [/^(?:money|paid) in$/, /^credit(?: amount)?$/, /^deposits?$/]),
    amount: pdfHeaderPosition(spans, [/^(?:transaction )?amount$/, /^value$/]),
    balance: pdfHeaderPosition(spans, [/^(?:running |account )?balance$/])
  };
  const hasAmount = (columns.outgoing !== null && columns.incoming !== null) || columns.amount !== null;
  return columns.date !== null && columns.description !== null && hasAmount ? columns : null;
}

function pdfHeaderSpans(items) {
  const spans = [];
  for (let start = 0; start < items.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= items.length; size += 1) {
      const selected = items.slice(start, start + size);
      spans.push({ text: normalisePdfHeader(selected.map((item) => item.text).join(' ')), x: selected[0].x });
    }
  }
  return spans;
}

function pdfHeaderPosition(spans, patterns) {
  const match = spans.find((span) => patterns.some((pattern) => pattern.test(span.text)));
  return match ? match.x : null;
}

function normalisePdfHeader(value) {
  return String(value || '').toLowerCase().replace(/£|gbp/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function nearestPdfColumn(x, columns, allowed = Object.keys(columns)) {
  const choices = allowed.filter((name) => columns[name] !== null && columns[name] !== undefined);
  return choices.sort((left, right) => Math.abs(columns[left] - x) - Math.abs(columns[right] - x))[0] || '';
}

function pdfColumnText(line, columns, target, dateItem) {
  if (columns[target] === null || columns[target] === undefined) return '';
  return line.items
    .filter((item) => item !== dateItem && !MONEY_PATTERN.test(String(item.text).replace(/\u00a0/g, ' ').trim()))
    .filter((item) => nearestPdfColumn(item.x, columns) === target)
    .map((item) => item.text)
    .join(' ')
    .trim();
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
  if (opening === null && records.length && records[0].runningBalance !== null) opening = roundMoney(records[0].runningBalance - records[0].incoming + records[0].outgoing);
  if (closing === null && records.length && records[records.length - 1].runningBalance !== null) closing = records[records.length - 1].runningBalance;
  const expectedClosing = opening === null ? null : roundMoney(opening + incoming - outgoing);
  const difference = expectedClosing === null || closing === null ? null : roundMoney(expectedClosing - closing);
  const reconciled = opening !== null && closing !== null && Math.abs(difference) <= RECONCILIATION_TOLERANCE;
  if (!records.length) warnings.push('No transaction rows could be read from this PDF.');
  if (records.length && !reconciled) warnings.push(reconciliationWarning(difference));
  const metadata = statementMetadataFromText(text, records);
  return {
    kind: 'statement', records, rejected: [], warnings, accountHint, source: fileName,
    accountIdentity: metadata.accountIdentity, period: metadata.period,
    summary: { incoming, outgoing, openingBalance: opening, closingBalance: closing, expectedClosing, reconciliationDifference: difference, ...metadata.summary }, reconciled
  };
}

function statementResult(records, rejected, warnings, accountHint, fileName, metadata = {}) {
  const ordered = chronologicalStatementRecords(records);
  const first = ordered.find((item) => Number.isFinite(item.runningBalance));
  const last = [...ordered].reverse().find((item) => Number.isFinite(item.runningBalance));
  const explicitOpening = metadata.summary?.explicitOpeningBalance;
  const explicitClosing = metadata.summary?.explicitClosingBalance;
  const openingBalance = Number.isFinite(explicitOpening) ? explicitOpening : first ? roundMoney(first.runningBalance - first.incoming + first.outgoing) : null;
  const closingBalance = Number.isFinite(explicitClosing) ? explicitClosing : last?.runningBalance ?? null;
  const hasCompleteRunningChain = ordered.length > 0 && ordered.every((item) => Number.isFinite(item.runningBalance));
  const balanceChainValid = hasCompleteRunningChain ? statementBalanceChainValid(ordered) : Number.isFinite(explicitOpening) && Number.isFinite(explicitClosing);
  const incoming = roundMoney(records.reduce((sum, item) => sum + item.incoming, 0));
  const outgoing = roundMoney(records.reduce((sum, item) => sum + item.outgoing, 0));
  const expectedClosing = openingBalance === null ? null : roundMoney(openingBalance + incoming - outgoing);
  const reconciliationDifference = expectedClosing === null || closingBalance === null ? null : roundMoney(expectedClosing - closingBalance);
  const reconciled = rejected.length === 0 && records.length > 0 && balanceChainValid
    && reconciliationDifference !== null && Math.abs(reconciliationDifference) <= RECONCILIATION_TOLERANCE;
  const nextWarnings = [...warnings];
  if (records.length && !reconciled) nextWarnings.push(reconciliationWarning(reconciliationDifference));
  return {
    kind: 'statement', records, rejected, warnings: [...new Set(nextWarnings)], accountHint, source: fileName,
    accountIdentity: metadata.accountIdentity || {}, period: metadata.period || {},
    summary: {
      incoming,
      outgoing,
      count: records.length,
      openingBalance,
      closingBalance,
      expectedClosing,
      reconciliationDifference,
      ...(metadata.summary || {})
    },
    reconciled
  };
}

function chronologicalStatementRecords(records) {
  if (records.length < 2) return [...records];
  const firstDate = records[0].date || '';
  const lastDate = records[records.length - 1].date || '';
  if (firstDate && lastDate && firstDate !== lastDate) return firstDate < lastDate ? [...records] : [...records].reverse();

  let ascendingScore = 0;
  let descendingScore = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!Number.isFinite(previous.runningBalance) || !Number.isFinite(current.runningBalance)) continue;
    const ascendingExpected = roundMoney(previous.runningBalance + current.incoming - current.outgoing);
    const descendingExpected = roundMoney(current.runningBalance + previous.incoming - previous.outgoing);
    if (Math.abs(ascendingExpected - current.runningBalance) <= 0.02) ascendingScore += 1;
    if (Math.abs(descendingExpected - previous.runningBalance) <= 0.02) descendingScore += 1;
  }
  return descendingScore > ascendingScore ? [...records].reverse() : [...records];
}

function statementBalanceChainValid(records) {
  if (!records.length || records.some((item) => !Number.isFinite(item.runningBalance))) return false;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1];
    const current = records[index];
    if (!Number.isFinite(previous.runningBalance) || !Number.isFinite(current.runningBalance)) continue;
    const expected = roundMoney(previous.runningBalance + current.incoming - current.outgoing);
    if (Math.abs(expected - current.runningBalance) > RECONCILIATION_TOLERANCE) return false;
  }
  return true;
}

function makeTransaction(input) {
  const incoming = roundMoney(Math.abs(Number(input.incoming || 0)));
  const outgoing = roundMoney(Math.abs(Number(input.outgoing || 0)));
  const date = parseDate(input.date);
  const description = String(input.description || 'Imported payment').trim();
  const classified = classifyTransaction(description, incoming, outgoing);
  return {
    id: stableId('transaction', input.accountHint, date, description, incoming, outgoing, input.sourceId || input.sourceRow),
    accountId: input.accountHint || '', date, postingDate: parseDate(input.postingDate), valueDate: parseDate(input.valueDate), budgetMonth: date?.slice(0, 7) || '',
    description, userDescription: input.userDescription || '', notes: input.notes || '',
    incoming, outgoing, runningBalance: input.balance ?? input.runningBalance ?? null,
    category: input.category || classified.category,
    transferStatus: input.transferStatus || classified.transferStatus, recurring: input.recurring ?? classified.recurring, cleared: true,
    source: input.source || 'manual', sourceRow: input.sourceRow || null, bankType: input.bankType || '',
    providerTransactionId: String(input.sourceId || input.providerTransactionId || '').trim(),
    reference: String(input.reference || '').trim(), transactionType: input.transactionType || classified.transactionType
  };
}

function classifyTransaction(description, incoming, outgoing) {
  const text = description.toLowerCase();
  if (incoming > 0) {
    const interest = /interest (?:paid|received|credit)|credit interest/.test(text);
    return { category: interest ? 'Interest received' : /pay office|salary|payroll|wages/.test(text) ? 'Income - pay' : 'Income / refund', transferStatus: /own account|internal transfer|account transfer/.test(text) ? 'possible' : 'no', recurring: false, transactionType: interest ? 'interest' : 'income' };
  }
  const rules = [
    [/daily od int|overdraft interest|interest charged|debit interest/, 'Interest charged'],
    [/overdraft fee|account fee|returned payment charge|foreign currency transaction fee|cash withdrawal fee/, 'Bank fees'],
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
  const transactionType = category === 'Bank fees' ? 'fee' : category === 'Interest charged' ? 'interest' : 'expense';
  return { category, transferStatus: /own account|internal transfer|account transfer/.test(text) ? 'possible' : 'no', recurring: /direct debit|standing order|recurring/.test(text), transactionType };
}

function statementMetadataFromText(text, records = [], overrides = {}) {
  const source = String(text || '');
  const dates = records.map((item) => item.date).filter(Boolean).sort();
  const explicit = statementPeriodFromText(source);
  const statementStartDate = overrides.statementStartDate || explicit.start || dates[0] || '';
  const statementEndDate = overrides.statementEndDate || explicit.end || dates.at(-1) || '';
  const periodSource = overrides.periodSource || (explicit.start || explicit.end ? 'explicit' : dates.length ? 'transactions' : 'unknown');
  const detectedInstitution = institutionDisplayName(detectInstitution(source))
    || labelledValue(source, /(?:financial institution|institution|bank|provider)/i);
  const institution = String(overrides.institution || detectedInstitution || '').trim();
  const labelledReference = labelledValue(source, /(?:account number|account no\.?|account reference)/i);
  const labelledSortCode = labelledValue(source, /sort code/i);
  const accountReference = safeAccountReference(overrides.accountReference || labelledReference);
  const sortCodeReference = safeAccountReference(overrides.sortCodeReference || labelledSortCode);
  const accountType = String(overrides.accountType || labelledValue(source, /account type/i) || '').trim();
  const currency = normaliseCurrency(overrides.currency) || currencyFromText(source);
  const explicitOpeningBalance = labelledMoney(source, /(?:opening balance|balance brought forward|previous balance|starting balance)/i);
  const explicitClosingBalance = labelledMoney(source, /(?:closing balance|balance carried forward|new balance|statement balance)/i);
  const accountIdentity = { institution, accountReference, sortCodeReference, accountType, currency };
  const period = { startDate: statementStartDate, endDate: statementEndDate, source: periodSource };
  return {
    accountIdentity,
    period,
    summary: {
      institution,
      accountReference,
      sortCodeReference,
      accountType,
      currency,
      statementStartDate,
      statementEndDate,
      statementPeriodSource: periodSource,
      parserConfidence: overrides.parserConfidence || '',
      explicitOpeningBalance,
      explicitClosingBalance
    }
  };
}

function statementPeriodFromText(value) {
  const text = normaliseWhitespace(value);
  const datePart = '(\\d{1,2}[/-]\\d{1,2}[/-](?:\\d{4}|\\d{2})|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+(?:\\d{4}|\\d{2})|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2})';
  const range = text.match(new RegExp(`(?:statement\\s+period|period|from)\\s*:?\\s*${datePart}\\s*(?:to|until|through|[-–—])\\s*${datePart}`, 'i'));
  if (range) return { start: parseDate(range[1]), end: parseDate(range[2]) };
  const start = text.match(new RegExp(`(?:statement\\s+(?:start|from)|period\\s+(?:start|from))\\s*:?\\s*${datePart}`, 'i'));
  const end = text.match(new RegExp(`(?:statement\\s+(?:end|to|date)|period\\s+(?:end|to))\\s*:?\\s*${datePart}`, 'i'));
  return { start: start ? parseDate(start[1]) : '', end: end ? parseDate(end[1]) : '' };
}

function labelledValue(text, labelPattern) {
  const match = String(text || '').match(new RegExp(`(?:^|\\n)[ \\t]*${labelPattern.source}[ \\t]*:?[ \\t]*([^\\r\\n]{1,80})`, 'i'));
  return match?.[1]?.trim() || '';
}

function labelledMoney(text, labelPattern) {
  const value = labelledValue(text, labelPattern);
  return value ? moneyFromText(value) : null;
}

function safeAccountReference(value) {
  const compact = String(value || '').replace(/[^A-Za-z0-9]/g, '');
  const visible = compact.slice(-4);
  return visible ? `••••${visible.toUpperCase()}` : '';
}

function normaliseCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function currencyFromText(value) {
  const text = String(value || '');
  const explicit = text.match(/\b(GBP|USD|EUR|AUD|CAD|NZD|JPY|CHF)\b/i)?.[1];
  if (explicit) return explicit.toUpperCase();
  if (/£/.test(text)) return 'GBP';
  if (/€/.test(text)) return 'EUR';
  if (/\$/.test(text)) return 'USD';
  return '';
}

function institutionDisplayName(key) {
  return ({ monzo: 'Monzo', halifax: 'Halifax', lloyds: 'Lloyds', 'bank-of-scotland': 'Bank of Scotland', nationwide: 'Nationwide' })[key] || '';
}

function reconciliationWarning(difference) {
  if (!Number.isFinite(difference)) return 'Balance could not be reconciled because reliable opening, running and closing balances were not all available. OneStep will not update the account balance.';
  return `Balance could not be reconciled. The transactions differ from the reported closing balance by £${Math.abs(difference).toFixed(2)}. OneStep will not update the account balance.`;
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
  if (/Lloyds Bank plc|www\.lloydsbank\.com|logo, Lloyds/i.test(text)) return 'lloyds';
  if (/Bank of Scotland plc|www\.bankofscotland\.co\.uk|logo, Bank of Scotland/i.test(text)) return 'bank-of-scotland';
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
  match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T].*)?$/);
  if (match) return validIso(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:[ T].*)?$/);
  if (match) return validIso(match[3].length === 2 ? `20${match[3]}` : match[3], match[2], match[1]);
  match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2}|\d{4})(?:[ T].*)?$/);
  if (match) return validIso(match[3].length === 2 ? `20${match[3]}` : match[3], MONTHS[match[2].slice(0, 3).toLowerCase()], match[1]);
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
  let text = String(value).trim().replace(/\u00a0/g, ' ');
  const trailingDebit = /\bDR$/i.test(text);
  text = text.replace(/\b(?:CR|DR)$/i, '').replace(/\s/g, '').replace(/£|GBP/gi, '').replace(/,/g, '');
  const parenthesised = /^\(.+\)$/.test(text);
  text = text.replace(/[()]/g, '').replace(/^\+/, '');
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return parenthesised || trailingDebit ? -Math.abs(number) : number;
}

function tag(block, name) {
  return block.match(new RegExp(`<${name}>([^<\\r\\n]+)`, 'i'))?.[1]?.trim() || '';
}

function findHeader(headers, candidates) {
  for (const candidate of candidates) {
    const exact = headers.indexOf(candidate);
    if (exact >= 0) return exact;
  }
  const exactOnly = new Set(['date', 'type', 'value', 'name', 'reference']);
  for (const candidate of candidates) {
    if (exactOnly.has(candidate)) continue;
    const partial = headers.findIndex((header) => header.includes(candidate));
    if (partial >= 0) return partial;
  }
  return -1;
}

function normaliseHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normaliseWhitespace(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\r/g, '');
}

function findStatementHeaderRow(rows) {
  return rows.slice(0, 30).findIndex((row) => {
    const headers = row.map((value) => normaliseHeader(value));
    const date = findHeader(headers, ['date', 'transaction date', 'posted date', 'posting date', 'booking date', 'completed date', 'effective date', 'value date']);
    const description = findHeader(headers, ['description', 'transaction description', 'details', 'merchant', 'payee', 'counter party', 'counterparty', 'narrative', 'reference', 'memo', 'name']);
    const amount = findHeader(headers, ['amount', 'transaction amount', 'value']);
    const debit = findHeader(headers, ['debit', 'debit amount', 'money out', 'withdrawal', 'paid out', 'spent']);
    const credit = findHeader(headers, ['credit', 'credit amount', 'money in', 'deposit', 'paid in', 'received']);
    return date >= 0 && description >= 0 && (amount >= 0 || debit >= 0 || credit >= 0);
  });
}

function transactionDirection(value) {
  const text = normaliseHeader(value).replace(/[_/-]+/g, ' ');
  if (!text) return '';
  if (/\b(credit|cr|fpi|bgc|deposit|money in|paid in|refund|salary|interest received)\b/.test(text)) return 'incoming';
  if (/\b(debit|dr|deb|fpo|dd|direct debit|so|standing order|chg|charge|atm|cpt|cash withdrawal|card payment|cash|purchase|money out|paid out|withdrawal)\b/.test(text)) return 'outgoing';
  return '';
}

function parseDelimitedRows(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const candidates = [',', '\t', ';'].map((delimiter) => {
    const rows = parseSeparatedRows(source, delimiter);
    const headerIndex = findStatementHeaderRow(rows);
    const populated = rows.slice(0, 30).filter((row) => row.some((cell) => String(cell).trim()));
    const width = Math.max(0, ...populated.map((row) => row.length));
    return { delimiter, rows, score: (headerIndex >= 0 ? 10000 : 0) + width * populated.length };
  });
  return candidates.sort((left, right) => right.score - left.score)[0].rows;
}

function parseSeparatedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { row.push(field); field = ''; }
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
