import {
  calculateBudgetAnalysis,
  debtSafetyAssessment,
  isExternalCashflowTransaction,
  isTransactionFinanciallyActive
} from './finance-core.js';

export const UNIFIED_FINANCIAL_PROFILE_VERSION = 1;
export const DEFAULT_STALE_AFTER_DAYS = 90;

export const UNIFIED_FACT_STATUS = Object.freeze({
  KNOWN: 'known',
  UNKNOWN: 'unknown',
  CONFLICT: 'conflict',
  STALE: 'stale'
});

const FACT_STATUS = UNIFIED_FACT_STATUS;

/**
 * Builds the shared, read-only financial position used by automation consumers.
 *
 * The returned profile is deliberately derived. It contains source references,
 * never source records, and must not be persisted as another financial store.
 */
export function buildUnifiedFinancialProfile(input = {}, options = {}) {
  const state = input && typeof input === 'object' ? input : {};
  const now = validDate(options.now);
  const staleAfterDays = positiveInteger(options.staleAfterDays, DEFAULT_STALE_AFTER_DAYS);
  const month = reportingMonth(options.month)
    || reportingMonth(state.settings?.selectedMonth)
    || localMonthKey(now);
  const uncertaintyFlags = [];
  const budgetAnalysis = calculateBudgetAnalysis(state, month);
  const safetyAssessment = debtSafetyAssessment(state, state.settings?.extraDebtPayment ?? 0);

  const liquidPosition = buildLiquidPosition(state, now, staleAfterDays, uncertaintyFlags);
  const income = buildIncomePosition(state, now, staleAfterDays, uncertaintyFlags);
  const debts = buildDebtPosition(state, safetyAssessment, now, staleAfterDays, uncertaintyFlags);
  const budget = buildBudgetContext(budgetAnalysis);
  const commitments = buildCommitmentSchedule(state, budgetAnalysis, safetyAssessment, uncertaintyFlags);
  const buffer = buildBufferPosition(state, uncertaintyFlags);
  const review = buildReviewPosition(state, uncertaintyFlags);
  const upcomingDates = buildUpcomingDates(state, now);
  const uncertainty = buildUncertaintySummary(uncertaintyFlags);

  return deepFreeze({
    kind: 'unified-financial-profile',
    version: UNIFIED_FINANCIAL_PROFILE_VERSION,
    derived: true,
    persist: false,
    asOf: now.toISOString(),
    sourceRevision: nonNegativeIntegerOrNull(state.meta?.revision),
    currency: stringValue(state.profile?.currency) || 'GBP',
    period: month,
    liquidPosition,
    income,
    commitments,
    budget,
    debts,
    buffer,
    upcomingDates,
    review,
    financialSafety: buildFinancialSafetyContext(safetyAssessment),
    uncertainty
  });
}

function buildLiquidPosition(state, now, staleAfterDays, flags) {
  const accounts = (state.accounts || []).filter((account) => account && account.active !== false).map((account) => {
    const source = sourceRef('account', account.id, 'currentBalance');
    const value = finiteOrNull(account.currentBalance);
    const evidenceDate = dateKey(account.statementDate);
    const stale = value !== null && evidenceDate && olderThan(evidenceDate, now, staleAfterDays);
    const status = value === null ? FACT_STATUS.UNKNOWN : stale ? FACT_STATUS.STALE : FACT_STATUS.KNOWN;
    const reasonCodes = value === null ? ['account_balance_unknown'] : stale ? ['account_balance_stale'] : ['authoritative_state_value'];
    if (value === null) addFlag(flags, 'blocking', 'account_balance_unknown', source, 'An active account balance is unknown.');
    if (stale) addFlag(flags, 'blocking', 'account_balance_stale', source, 'An active account balance is based on stale evidence.');
    return {
      id: String(account.id || ''),
      name: stringValue(account.name) || 'Unnamed account',
      type: stringValue(account.type) || 'unknown',
      liquid: isLiquidAccount(account),
      balance: fact(value, { status, confidence: evidenceDate ? 'reconciled' : 'explicit', provenance: [source], reasonCodes }),
      evidenceDate: evidenceDate || null
    };
  });
  const liquidAccounts = accounts.filter((account) => account.liquid);
  const total = roundMoney(liquidAccounts.reduce((sum, account) => sum + Number(account.balance.value || 0), 0));
  const statuses = new Set(liquidAccounts.map((account) => account.balance.status));
  if (!liquidAccounts.length) addFlag(flags, 'blocking', 'liquid_accounts_not_configured', sourceRef('accounts', '', ''), 'No active liquid account is configured.');
  const status = !liquidAccounts.length || statuses.has(FACT_STATUS.UNKNOWN) ? FACT_STATUS.UNKNOWN
    : statuses.has(FACT_STATUS.STALE) ? FACT_STATUS.STALE
      : FACT_STATUS.KNOWN;
  return {
    total: fact(total, {
      status,
      confidence: status === FACT_STATUS.KNOWN ? 'authoritative' : 'partial',
      provenance: liquidAccounts.map((account) => sourceRef('account', account.id, 'currentBalance')),
      reasonCodes: status === FACT_STATUS.KNOWN ? ['sum_of_active_liquid_accounts'] : ['liquid_position_incomplete']
    }),
    complete: status === FACT_STATUS.KNOWN,
    accounts,
    liquidAccountIds: liquidAccounts.map((account) => account.id)
  };
}

function buildIncomePosition(state, now, staleAfterDays, flags) {
  const manualValue = finiteNonNegativeOrNull(state.profile?.dependableIncome);
  const manualConfirmed = manualValue !== null && manualValue > 0;
  const dependableMonthlyTotal = fact(manualValue ?? 0, {
    status: manualConfirmed ? FACT_STATUS.KNOWN : FACT_STATUS.UNKNOWN,
    confidence: manualConfirmed ? 'explicit' : 'unconfirmed',
    provenance: [sourceRef('profile', 'profile', 'dependableIncome')],
    reasonCodes: manualConfirmed ? ['manual_value_precedes_inference'] : ['dependable_income_not_confirmed']
  });
  if (!manualConfirmed) addFlag(flags, 'blocking', 'dependable_income_not_confirmed', sourceRef('profile', 'profile', 'dependableIncome'), 'Dependable monthly income has not been confirmed.');

  const streams = [
    ...(manualConfirmed ? [{
      id: 'manual-dependable-total',
      name: 'Confirmed dependable income',
      kind: 'manual_total',
      dependable: true,
      includedInDependableTotal: true,
      monthlyAmount: dependableMonthlyTotal,
      evidenceCount: 1,
      latestDate: null
    }] : []),
    ...payslipIncomeStreams(state.payslips || [], now, staleAfterDays, flags),
    ...transactionIncomeStreams(state.transactions || [], now, staleAfterDays, flags)
  ];

  return {
    dependableMonthlyTotal,
    precedence: manualConfirmed ? 'manual' : 'unknown',
    inferredValuesUsedInDependableTotal: false,
    streams: streams.sort((left, right) => left.id.localeCompare(right.id))
  };
}

function payslipIncomeStreams(payslips, now, staleAfterDays, flags) {
  const groups = new Map();
  for (const payslip of payslips.filter(Boolean)) {
    const key = incomeStreamKey(
      payslip.incomeStreamId || payslip.employerPayeReference || payslip.employer || payslip.provider || payslip.source || payslip.id,
      'payslip'
    );
    const group = groups.get(key) || [];
    group.push(payslip);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, records]) => {
    const ordered = [...records].sort((left, right) => incomeDate(right).localeCompare(incomeDate(left)));
    const latest = ordered[0];
    const amount = finiteNonNegativeOrNull(latest?.netPay);
    const latestDate = incomeDate(latest);
    const stale = amount !== null && latestDate && olderThan(latestDate, now, staleAfterDays);
    const source = sourceRef('payslip', latest?.id, 'netPay');
    if (stale) addFlag(flags, 'warning', 'income_evidence_stale', source, 'An observed income stream is based on stale payslip evidence.');
    if (amount === null) addFlag(flags, 'warning', 'income_amount_unknown', source, 'An observed payslip income amount is unknown.');
    return {
      id: `payslip:${key}`,
      name: stringValue(latest?.employer || latest?.provider || latest?.source) || 'Payslip income',
      kind: 'payslip_observation',
      dependable: false,
      includedInDependableTotal: false,
      monthlyAmount: fact(amount, {
        status: amount === null ? FACT_STATUS.UNKNOWN : stale ? FACT_STATUS.STALE : FACT_STATUS.KNOWN,
        confidence: records.length > 1 ? 'observed_repeated' : 'observed_once',
        provenance: [source],
        reasonCodes: ['observed_not_confirmed_dependable']
      }),
      evidenceCount: records.length,
      latestDate: latestDate || null
    };
  });
}

function transactionIncomeStreams(transactions, now, staleAfterDays, flags) {
  const groups = new Map();
  for (const transaction of transactions) {
    if (!isTransactionFinanciallyActive(transaction) || !isExternalCashflowTransaction(transaction)) continue;
    if (Number(transaction.incoming || 0) <= 0) continue;
    if (transaction.recurring !== true && normalise(transaction.category) !== 'income') continue;
    const label = stringValue(transaction.userDescription || transaction.description) || 'Income payment';
    const key = `${String(transaction.accountId || 'unlinked')}:${incomeStreamKey(label, 'transaction')}`;
    const group = groups.get(key) || [];
    group.push(transaction);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, records]) => {
    const ordered = [...records].sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
    const latest = ordered[0];
    const recent = ordered.slice(0, 3);
    const amount = recent.length ? roundMoney(recent.reduce((sum, item) => sum + Number(item.incoming || 0), 0) / recent.length) : null;
    const latestDate = validDateKey(latest?.date) ? latest.date : '';
    const stale = amount !== null && latestDate && olderThan(latestDate, now, staleAfterDays);
    const source = sourceRef('transaction', latest?.id, 'incoming');
    if (stale) addFlag(flags, 'warning', 'income_evidence_stale', source, 'An observed income stream is based on stale transaction evidence.');
    return {
      id: `transaction:${key}`,
      name: stringValue(latest?.userDescription || latest?.description) || 'Income payment',
      kind: 'transaction_observation',
      dependable: false,
      includedInDependableTotal: false,
      monthlyAmount: fact(amount, {
        status: amount === null ? FACT_STATUS.UNKNOWN : stale ? FACT_STATUS.STALE : FACT_STATUS.KNOWN,
        confidence: records.length > 1 && records.every((item) => item.recurring === true) ? 'observed_recurring' : 'observed_once',
        provenance: recent.map((item) => sourceRef('transaction', item.id, 'incoming')),
        reasonCodes: ['observed_not_confirmed_dependable']
      }),
      evidenceCount: records.length,
      latestDate: latestDate || null
    };
  });
}

function buildDebtPosition(state, safetyAssessment, now, staleAfterDays, flags) {
  const safetyById = new Map(safetyAssessment.accounts.map((account) => [String(account.id), account]));
  const sourceRecords = [
    ...(state.debts || []).filter(Boolean).map((record) => ({ record, kind: 'debt' })),
    ...(state.overdrafts || []).filter(Boolean).map((record) => ({ record, kind: 'overdraft' }))
  ];
  const accounts = sourceRecords.map(({ record, kind }) => {
    const id = String(record.id || '');
    const safety = safetyById.get(id);
    const balanceSource = sourceRef(kind, id, 'currentBalance');
    const balanceValue = finiteNonNegativeOrNull(record.currentBalance);
    const evidenceDate = firstDateKey(record.balanceEffectiveDate, record.statementDate, record.lastReportedAt);
    const stale = balanceValue !== null && evidenceDate && olderThan(evidenceDate, now, staleAfterDays);
    if (balanceValue === null) addFlag(flags, 'blocking', 'debt_balance_unknown', balanceSource, 'A borrowing balance is unknown.');
    if (stale && balanceValue > 0) addFlag(flags, 'blocking', 'debt_balance_stale', balanceSource, 'A borrowing balance is based on stale evidence.');
    const statusSource = sourceRef(kind, id, 'status');
    const effectiveStatus = safety?.effectiveStatus || normaliseDebtStatus(record.status);
    const statusConflict = Boolean(record.statusConflict) || Boolean(safety?.reasonCodes?.includes('conflicting_status'));
    const statusUnknown = effectiveStatus === 'unknown';
    if (statusConflict) addFlag(flags, 'blocking', 'debt_status_conflict', statusSource, 'A borrowing status has conflicting evidence.');
    else if (statusUnknown && Number(balanceValue || 0) > 0) addFlag(flags, 'blocking', 'debt_status_unknown', statusSource, 'A borrowing status is unknown.');

    const requiredSourceField = safety?.arrangementStatus === 'confirmed' ? 'arrangementPayment' : 'contractualPayment';
    const requiredSource = sourceRef(kind, id, requiredSourceField);
    const requiredValue = finiteNonNegativeOrNull(safety?.requiredPayment);
    if (Number(balanceValue || 0) > 0 && requiredValue === null) addFlag(flags, 'blocking', 'debt_required_payment_unknown', requiredSource, 'A required borrowing payment is unknown.');
    for (const reasonCode of safety?.reasonCodes || []) {
      addFlag(flags, 'blocking', `financial_safety_${reasonCode}`, statusSource, 'Financial Safety marked this borrowing fact as unresolved.');
    }

    return {
      id,
      name: stringValue(record.name) || 'Unnamed account',
      kind,
      includedInPlan: record.includeInPlan !== false,
      balance: fact(balanceValue, {
        status: balanceValue === null ? FACT_STATUS.UNKNOWN : stale ? FACT_STATUS.STALE : FACT_STATUS.KNOWN,
        confidence: evidenceDate ? 'reconciled' : 'explicit',
        provenance: [balanceSource],
        reasonCodes: balanceValue === null ? ['balance_unknown'] : stale ? ['balance_stale'] : ['authoritative_state_value']
      }),
      status: fact(effectiveStatus, {
        status: statusConflict ? FACT_STATUS.CONFLICT : statusUnknown ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
        confidence: statusConflict ? 'conflicting' : 'authoritative',
        provenance: [statusSource, ...(record.sourceCreditReportId ? [sourceRef('credit_report', record.sourceCreditReportId, 'reportedStatus')] : [])],
        reasonCodes: safety?.reasonCodes || (statusUnknown ? ['status_unknown'] : ['financial_safety_effective_status'])
      }),
      arrangementStatus: fact(safety?.arrangementStatus || normaliseArrangement(record.arrangementStatus), {
        status: (safety?.arrangementStatus || normaliseArrangement(record.arrangementStatus)) === 'unknown' ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
        confidence: 'authoritative',
        provenance: [sourceRef(kind, id, 'arrangementStatus')],
        reasonCodes: []
      }),
      requiredPayment: fact(requiredValue, {
        status: requiredValue === null ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
        confidence: 'authoritative',
        provenance: [requiredSource],
        reasonCodes: requiredValue === null ? ['required_payment_unknown'] : ['financial_safety_required_payment']
      }),
      apr: optionalNumberFact(record.apr, sourceRef(kind, id, 'apr')),
      limit: optionalNumberFact(kind === 'overdraft' ? record.limit : record.creditLimit, sourceRef(kind, id, kind === 'overdraft' ? 'limit' : 'creditLimit')),
      arrearsAmount: optionalNumberFact(record.arrearsAmount, sourceRef(kind, id, 'arrearsAmount')),
      defaultDate: validDateKey(record.defaultDate) ? record.defaultDate : null,
      evidenceDate: evidenceDate || null,
      eligibleForExtra: Boolean(safety?.eligibleForExtra),
      financialSafetyReasonCodes: [...(safety?.reasonCodes || [])]
    };
  });
  return {
    totalOwed: fact(roundMoney(accounts.reduce((sum, account) => sum + Number(account.balance.value || 0), 0)), {
      status: accounts.some((account) => account.balance.status === FACT_STATUS.UNKNOWN) ? FACT_STATUS.UNKNOWN
        : accounts.some((account) => account.balance.status === FACT_STATUS.STALE) ? FACT_STATUS.STALE
          : FACT_STATUS.KNOWN,
      confidence: 'derived',
      provenance: accounts.map((account) => sourceRef(account.kind, account.id, 'currentBalance')),
      reasonCodes: ['sum_of_borrowing_balances']
    }),
    requiredPaymentTotal: fact(safetyAssessment.requiredPaymentTotal, {
      status: accounts.some((account) => Number(account.balance.value || 0) > 0 && account.requiredPayment.status === FACT_STATUS.UNKNOWN) ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
      confidence: 'financial_safety',
      provenance: accounts.map((account) => sourceRef(account.kind, account.id, 'requiredPayment')),
      reasonCodes: ['financial_safety_required_payment_total']
    }),
    accounts
  };
}

function buildBudgetContext(analysis) {
  return {
    period: analysis.month,
    monthCount: analysis.monthCount,
    planned: analysis.planned,
    actual: analysis.actual,
    categorisedActual: analysis.categorisedActual,
    uncategorisedActual: analysis.uncategorisedActual,
    remaining: analysis.remaining,
    coveragePercent: analysis.coveragePercent,
    categories: analysis.rows.map((row) => ({
      id: String(row.id || ''),
      name: stringValue(row.category) || 'Unnamed category',
      section: stringValue(row.section) || 'Unspecified',
      monthlyPlanned: row.monthlyPlanned,
      planned: row.planned,
      actual: row.actual,
      remaining: row.remaining,
      transactionIds: (row.contributions || []).map((contribution) => String(contribution.id || '')).filter(Boolean),
      provenance: [sourceRef('budget', row.id, 'planned')]
    })),
    uncategorisedTransactionIds: [...analysis.uncategorisedTransactionIds]
  };
}

function buildCommitmentSchedule(state, budgetAnalysis, safetyAssessment, flags) {
  const budgetItems = budgetAnalysis.rows.filter((row) => Number(row.monthlyPlanned || 0) > 0).map((row) => ({
    id: `budget:${String(row.id || '')}`,
    kind: 'budget',
    name: stringValue(row.category) || 'Budget commitment',
    amount: fact(row.monthlyPlanned, { status: FACT_STATUS.KNOWN, confidence: 'explicit', provenance: [sourceRef('budget', row.id, 'planned')], reasonCodes: ['monthly_budget_commitment'] }),
    cadence: 'monthly',
    dueDate: fact(null, { status: FACT_STATUS.UNKNOWN, confidence: 'not_applicable', provenance: [sourceRef('budget', row.id, 'dueDate')], reasonCodes: ['monthly_commitment_has_no_specific_due_date'] }),
    includedInMonthlyTotal: true
  }));
  const scheduledItems = (state.scheduledPayments || []).filter(activeScheduledPayment).map((payment) => {
    const source = sourceRef('scheduled_payment', payment.id, 'amount');
    const amount = finiteNonNegativeOrNull(payment.amount ?? payment.outgoing ?? payment.payment);
    const dueDate = dateKey(payment.dueDate);
    if (amount === null) addFlag(flags, 'blocking', 'scheduled_payment_amount_unknown', source, 'A scheduled payment amount is unknown.');
    if (!dueDate) addFlag(flags, 'blocking', 'scheduled_payment_date_unknown', sourceRef('scheduled_payment', payment.id, 'dueDate'), 'A scheduled payment date is unknown.');
    return {
      id: `scheduled:${String(payment.id || '')}`,
      kind: 'scheduled_payment',
      name: stringValue(payment.name || payment.description) || 'Scheduled payment',
      amount: fact(amount, { status: amount === null ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN, confidence: 'explicit', provenance: [source], reasonCodes: amount === null ? ['amount_unknown'] : ['scheduled_commitment'] }),
      cadence: stringValue(payment.cadence) || 'scheduled',
      dueDate: fact(dueDate || null, {
        status: dueDate ? FACT_STATUS.KNOWN : FACT_STATUS.UNKNOWN,
        confidence: 'explicit',
        provenance: [sourceRef('scheduled_payment', payment.id, 'dueDate')],
        reasonCodes: dueDate ? ['scheduled_due_date'] : ['due_date_unknown']
      }),
      includedInMonthlyTotal: payment.includedInBudget !== true
    };
  });
  const budgetedDebtTotal = roundMoney(safetyAssessment.requiredPaymentTotal - safetyAssessment.unbudgetedRequiredPayments);
  const debtSources = new Map([
    ...(state.debts || []).filter(Boolean).map((record) => [String(record.id || ''), record]),
    ...(state.overdrafts || []).filter(Boolean).map((record) => [String(record.id || ''), record])
  ]);
  const debtItems = safetyAssessment.accounts.filter((account) => account.requiredPayment !== null).map((account) => {
    const record = debtSources.get(String(account.id || '')) || {};
    const dueDate = firstDateKey(record.nextPaymentDate, record.paymentDueDate, record.dueDate);
    return {
      id: `debt:${String(account.id || '')}`,
      kind: 'required_debt_payment',
      name: account.name,
      amount: fact(account.requiredPayment, { status: FACT_STATUS.KNOWN, confidence: 'financial_safety', provenance: [sourceRef(account.kind, account.id, 'requiredPayment')], reasonCodes: ['financial_safety_required_payment'] }),
      cadence: 'monthly',
      dueDate: fact(dueDate || null, {
        status: dueDate ? FACT_STATUS.KNOWN : FACT_STATUS.UNKNOWN,
        confidence: 'explicit',
        provenance: [sourceRef(account.kind, account.id, 'dueDate')],
        reasonCodes: dueDate ? ['required_payment_due_date'] : ['due_date_unknown']
      }),
      includedInMonthlyTotal: null,
      monthlyTotalTreatment: 'aggregate_required_payment'
    };
  });
  const monthlyTotal = roundMoney(budgetAnalysis.planned + safetyAssessment.unbudgetedRequiredPayments + safetyAssessment.scheduledCommitments);
  return {
    knownMonthlyTotal: fact(monthlyTotal, {
      status: scheduledItems.some((item) => item.amount.status === FACT_STATUS.UNKNOWN) ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
      confidence: 'derived_authoritative',
      provenance: [...budgetItems, ...scheduledItems, ...debtItems].flatMap((item) => item.amount.provenance),
      reasonCodes: ['budget_plus_unbudgeted_required_debt_plus_unbudgeted_scheduled']
    }),
    budgetedDebtPaymentTotal: budgetedDebtTotal,
    unbudgetedRequiredDebtPaymentTotal: safetyAssessment.unbudgetedRequiredPayments,
    unbudgetedScheduledPaymentTotal: safetyAssessment.scheduledCommitments,
    items: [...budgetItems, ...scheduledItems, ...debtItems]
  };
}

function buildBufferPosition(state, flags) {
  const balance = finiteNonNegativeOrNull(state.settings?.emergencyBufferBalance);
  const target = finiteNonNegativeOrNull(state.settings?.emergencyBufferTarget);
  if (balance === null) addFlag(flags, 'blocking', 'buffer_balance_unknown', sourceRef('settings', 'settings', 'emergencyBufferBalance'), 'The emergency buffer balance is unknown.');
  if (target === null) addFlag(flags, 'blocking', 'buffer_target_unknown', sourceRef('settings', 'settings', 'emergencyBufferTarget'), 'The emergency buffer target is unknown.');
  return {
    balance: fact(balance, { status: balance === null ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN, confidence: 'explicit', provenance: [sourceRef('settings', 'settings', 'emergencyBufferBalance')], reasonCodes: [] }),
    target: fact(target, { status: target === null ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN, confidence: 'explicit', provenance: [sourceRef('settings', 'settings', 'emergencyBufferTarget')], reasonCodes: [] }),
    shortfall: balance === null || target === null ? null : roundMoney(Math.max(0, target - balance))
  };
}

function buildReviewPosition(state, flags) {
  const active = (state.reviewItems || []).filter((item) => item?.status !== 'resolved').map((item) => ({
    id: String(item.id || ''),
    type: stringValue(item.type) || 'unknown',
    status: stringValue(item.status) || 'needs_attention',
    priority: stringValue(item.priority) || 'normal',
    source: sourceRef(item.sourceType || 'review_source', item.sourceId, '')
  }));
  for (const item of active) {
    const severity = item.priority === 'high' || ['possible_duplicate', 'import_conflict', 'financial_action'].includes(item.type) ? 'blocking' : 'warning';
    addFlag(flags, severity, `review_${item.type}`, item.source, 'An unresolved Review item may affect financial decisions.');
  }
  for (const transaction of (state.transactions || []).filter(Boolean)) {
    if (transaction?.duplicateStatus === 'possible' && transaction.reviewStatus !== 'accepted' && transaction.reviewStatus !== 'rejected') {
      addFlag(flags, 'blocking', 'pending_possible_duplicate', sourceRef('transaction', transaction.id, 'reviewStatus'), 'A possible duplicate is financially inactive pending review.');
    }
  }
  for (const batch of (state.importBatches || []).filter(Boolean)) {
    if (batch?.reconciliationState === 'review-required' && !batch.reviewDecision) {
      addFlag(flags, 'blocking', 'unresolved_import_conflict', sourceRef('import_batch', batch.id, 'reconciliationState'), 'An import conflict is unresolved.');
    }
  }
  return {
    total: active.length,
    important: active.filter((item) => item.priority === 'high').length,
    items: active
  };
}

function buildUpcomingDates(state, now) {
  const today = localDateKey(now);
  const dates = [];
  const paydayDay = Number(state.profile?.paydayDay);
  if (Number.isInteger(paydayDay) && paydayDay >= 1 && paydayDay <= 31) {
    dates.push({ kind: 'payday', date: nextMonthlyDate(now, paydayDay), source: sourceRef('profile', 'profile', 'paydayDay') });
  }
  for (const payment of state.scheduledPayments || []) {
    const dueDate = dateKey(payment?.dueDate);
    if (!activeScheduledPayment(payment) || !dueDate || dueDate < today) continue;
    dates.push({ kind: 'scheduled_payment', date: dueDate, source: sourceRef('scheduled_payment', payment.id, 'dueDate') });
  }
  for (const [kind, records] of [['debt', state.debts || []], ['overdraft', state.overdrafts || []]]) {
    for (const record of records.filter(Boolean)) {
      const dueDate = firstDateKey(record.nextPaymentDate, record.paymentDueDate, record.dueDate);
      if (dueDate && dueDate >= today) dates.push({ kind: 'required_debt_payment', date: dueDate, source: sourceRef(kind, record.id, 'dueDate') });
    }
  }
  const unique = new Map(dates.map((item) => [`${item.kind}:${item.date}:${item.source.kind}:${item.source.id}`, item]));
  return [...unique.values()].sort((left, right) => left.date.localeCompare(right.date) || left.kind.localeCompare(right.kind));
}

function buildFinancialSafetyContext(assessment) {
  return {
    safeToOverpay: assessment.safeToOverpay,
    overpaymentStatus: assessment.overpaymentStatus,
    requestedExtraPayment: assessment.requestedExtraPayment,
    safeExtraPayment: assessment.safeExtraPayment,
    requiredPaymentTotal: assessment.requiredPaymentTotal,
    unbudgetedRequiredPayments: assessment.unbudgetedRequiredPayments,
    scheduledCommitments: assessment.scheduledCommitments,
    plannedCapacity: assessment.plannedCapacity,
    currentCashCapacity: assessment.currentCashCapacity,
    blockerAccountIds: assessment.accounts.filter((account) => account.blockingReasons.length).map((account) => String(account.id || '')),
    reasonCodes: [...new Set(assessment.accounts.flatMap((account) => account.reasonCodes))]
  };
}

function buildUncertaintySummary(flags) {
  const unique = new Map();
  for (const item of flags) unique.set(`${item.severity}:${item.code}:${item.source.kind}:${item.source.id}:${item.source.field}`, item);
  const items = [...unique.values()].sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.code.localeCompare(right.code));
  const blocking = items.filter((item) => item.severity === 'blocking');
  return {
    safeForAutomation: blocking.length === 0,
    blocking,
    warnings: items.filter((item) => item.severity === 'warning'),
    all: items
  };
}

function optionalNumberFact(value, source) {
  const number = finiteNonNegativeOrNull(value);
  return fact(number, {
    status: number === null ? FACT_STATUS.UNKNOWN : FACT_STATUS.KNOWN,
    confidence: 'authoritative',
    provenance: [source],
    reasonCodes: number === null ? ['value_unknown'] : ['authoritative_state_value']
  });
}

function fact(value, options) {
  return {
    value,
    status: options.status,
    confidence: options.confidence,
    safeToUse: options.status === FACT_STATUS.KNOWN,
    provenance: options.provenance.map((item) => ({ ...item })),
    reasonCodes: [...new Set(options.reasonCodes || [])]
  };
}

function sourceRef(kind, id, field) {
  return { kind: stringValue(kind) || 'unknown', id: String(id || ''), field: stringValue(field) };
}

function addFlag(flags, severity, code, source, reason) {
  flags.push({ severity, code, source: { ...source }, reason });
}

function activeScheduledPayment(item) {
  return item && !item.paidAt && !item.completedAt && !['paid', 'cancelled', 'canceled'].includes(normalise(item.status));
}

function isLiquidAccount(account) {
  return ['current', 'current account', 'checking', 'cash', 'cash account', 'savings', 'savings account'].includes(normalise(account.type));
}

function incomeStreamKey(value, fallback) {
  return normalise(value).replace(/\s+/g, '-') || fallback;
}

function incomeDate(record) {
  return dateKey(record?.payDate) || (reportingMonth(record?.period) ? `${record.period}-01` : '');
}

function firstDateKey(...values) {
  for (const value of values) {
    const key = dateKey(value);
    if (key) return key;
  }
  return '';
}

function dateKey(value) {
  const key = String(value || '').slice(0, 10);
  return validDateKey(key) ? key : '';
}

function nextMonthlyDate(now, requestedDay) {
  const candidate = (year, month) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(requestedDay, lastDay));
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = candidate(today.getFullYear(), today.getMonth());
  if (next < today) next = candidate(today.getFullYear(), today.getMonth() + 1);
  return localDateKey(next);
}

function olderThan(value, now, days) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && (now.getTime() - date.getTime()) / 86_400_000 > days;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function validDateKey(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function reportingMonth(value) {
  const text = String(value || '');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
}

function localMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNonNegativeOrNull(value) {
  const number = finiteOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normaliseDebtStatus(value) {
  const status = normalise(value).replace(/ /g, '_');
  return ['current', 'arrears', 'defaulted', 'over_limit'].includes(status) ? status : 'unknown';
}

function normaliseArrangement(value) {
  const status = normalise(value);
  return ['none', 'confirmed'].includes(status) ? status : 'unknown';
}

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function stringValue(value) {
  return String(value || '').trim();
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function severityRank(value) {
  return value === 'blocking' ? 0 : 1;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
