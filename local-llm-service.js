import { calculateBudgetAnalysis, calculatePeriodSummary, debtPlan } from './finance-core.js';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/chat';

export async function checkLocalModel(model = 'qwen2.5:1.5b') {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { available: false, reason: 'Ollama did not respond.' };
    const data = await response.json();
    const names = (data.models || []).map((item) => item.name);
    const installed = names.some((name) => name === model || name.startsWith(`${model}:`));
    return { available: installed, connected: true, installedModels: names, reason: installed ? '' : `${model} is not installed.` };
  } catch {
    return { available: false, connected: false, installedModels: [], reason: 'Ollama is not running on this computer.' };
  }
}

export async function askLocalModel(question, state, model = 'qwen2.5:1.5b') {
  const status = await checkLocalModel(model);
  if (!status.available) return { ok: false, status };

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.15, num_predict: 420 },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: `${financialSnapshot(state)}\n\nQUESTION:\n${String(question || '').slice(0, 1200)}` }
      ]
    })
  });
  if (!response.ok) return { ok: false, status: { ...status, reason: `The local model returned ${response.status}.` } };
  const data = await response.json();
  const message = String(data.message?.content || '').trim();
  return message ? { ok: true, mode: 'local-llm', message, status } : { ok: false, status: { ...status, reason: 'The local model returned no answer.' } };
}

export function financialSnapshot(state) {
  const plan = debtPlan(state, 'hybrid');
  const month = state.settings?.selectedMonth || '';
  const summary = calculatePeriodSummary(state, month);
  const incoming = money(summary.income);
  const outgoing = money(summary.spending);
  const budgetAnalysis = calculateBudgetAnalysis(state, month);
  const budgets = budgetAnalysis.rows.map((item) => `${item.category}: planned ${money(item.planned)}, spent ${money(item.actual)}, remaining ${money(item.remaining)}`).join('; ');
  const debts = (state.debts || []).map((item) => `${item.name}: balance ${money(item.currentBalance)}, APR ${item.apr == null ? 'unknown' : `${(item.apr * 100).toFixed(2)}%`}, contractual payment ${knownMoney(item.contractualPayment)}, status ${item.status || 'unknown'}, arrangement ${item.arrangementStatus || 'unknown'}, arrangement payment ${knownMoney(item.arrangementPayment)}, status conflict ${item.statusConflict ? 'yes' : 'no'}, interest frozen ${item.interestFrozen ? 'yes' : 'no'}`).join('\n');
  const overdrafts = (state.overdrafts || []).map((item) => `${item.name}: used ${money(item.currentBalance)}, limit ${knownMoney(item.limit)}, APR ${item.apr == null ? 'unknown' : `${(item.apr * 100).toFixed(2)}%`}, contractual payment ${knownMoney(item.contractualPayment)}, status ${item.status || 'unknown'}, arrangement ${item.arrangementStatus || 'unknown'}, arrangement payment ${knownMoney(item.arrangementPayment)}, status conflict ${item.statusConflict ? 'yes' : 'no'}`).join('\n');
  return [
    'VERIFIED LOCAL FINANCIAL SNAPSHOT',
    `Selected month: ${month}`,
    `Dependable monthly bank income: ${money(state.profile?.dependableIncome)}`,
    `External cash flow: ${incoming} in; ${outgoing} out; ${money(incoming - outgoing)} net`,
    `Starter buffer: ${money(state.settings?.emergencyBufferBalance)} of ${money(state.settings?.emergencyBufferTarget)}`,
    `Planned extra debt payment: ${money(state.settings?.extraDebtPayment)}`,
    `Budgets: ${budgets}`,
    `Uncategorised spending: ${money(budgetAnalysis.uncategorisedActual)}; categorisation coverage ${budgetAnalysis.coveragePercent}%.`,
    `Debts:\n${debts}`,
    `Overdrafts:\n${overdrafts}`,
    `Financial-safety result: ${plan.overpaymentStatus}; requested optional payment ${money(plan.requestedExtraPayment)}; safely included optional payment ${money(plan.safeExtraPayment)}.`,
    `Safety explanations: ${plan.explanations.join(' | ') || 'none'}`,
    `Accounts excluded from optional payments: ${plan.excludedAccounts.map((item) => `${item.name} (${item.reason})`).join('; ') || 'none'}`,
    'Unknown values are genuinely unknown. Do not replace them with zero.'
  ].join('\n');
}

function systemPrompt() {
  return `You are a small, private UK personal-finance guide running entirely on the user's computer.
Use only the verified snapshot. Never invent balances, APRs, due dates, payment arrangements or savings.
Apply this safety order: essential living costs; payments needed to prevent missed payments/defaults; contractual minimums; a small emergency buffer; only then overpayments.
Treat OneStep's financial-safety result as a hard ceiling. Never recommend more than the safely included optional payment, and recommend no extra payment when the result is blocked.
Never overpay a defaulted or arrears account beyond a confirmed arrangement. Never call provisional money "available" when bills, arrangements, required payments, limits or statuses are unknown. Never tell the user to borrow, gamble, invest to solve debt, or ignore a creditor.
Keep the response ADHD-friendly. Give at most one Immediate action, then optional This week and This month sections. Each action needs a short time estimate. Use short sentences and no more than 180 words.
Distinguish debts from overdrafts. Explain unknowns plainly. If a formal debt solution may be relevant, suggest free UK debt advice without claiming that it is definitely suitable.
This is guidance, not authority to move money or contact anyone.`;
}

function money(value) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));
}

function knownMoney(value) {
  return value === null || value === undefined || value === '' ? 'unknown' : money(value);
}
