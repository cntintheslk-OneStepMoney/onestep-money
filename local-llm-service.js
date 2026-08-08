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

function financialSnapshot(state) {
  const month = state.settings?.selectedMonth || '';
  const monthRows = (state.transactions || []).filter((item) => String(item.budgetMonth || item.date).startsWith(month) && item.transferStatus !== 'confirmed');
  const incoming = money(monthRows.reduce((sum, item) => sum + Number(item.incoming || 0), 0));
  const outgoing = money(monthRows.reduce((sum, item) => sum + Number(item.outgoing || 0), 0));
  const budgets = (state.budgets || []).map((item) => `${item.category}: planned ${money(item.planned)}`).join('; ');
  const debts = (state.debts || []).map((item) => `${item.name}: balance ${money(item.currentBalance)}, APR ${item.apr == null ? 'unknown' : `${(item.apr * 100).toFixed(2)}%`}, payment ${item.contractualPayment ? money(item.contractualPayment) : 'unknown'}, status ${item.status}, interest frozen ${item.interestFrozen ? 'yes' : 'no'}`).join('\n');
  const overdrafts = (state.overdrafts || []).map((item) => `${item.name}: used ${money(item.currentBalance)}, limit ${item.limit ? money(item.limit) : 'unknown'}, APR ${item.apr == null ? 'unknown' : `${(item.apr * 100).toFixed(2)}%`}, status ${item.status}`).join('\n');
  return [
    'VERIFIED LOCAL FINANCIAL SNAPSHOT',
    `Selected month: ${month}`,
    `Dependable monthly bank income: ${money(state.profile?.dependableIncome)}`,
    `External cash flow: ${incoming} in; ${outgoing} out; ${money(incoming - outgoing)} net`,
    `Starter buffer: ${money(state.settings?.emergencyBufferBalance)} of ${money(state.settings?.emergencyBufferTarget)}`,
    `Planned extra debt payment: ${money(state.settings?.extraDebtPayment)}`,
    `Budgets: ${budgets}`,
    `Debts:\n${debts}`,
    `Overdrafts:\n${overdrafts}`,
    'Unknown values are genuinely unknown. Do not replace them with zero.'
  ].join('\n');
}

function systemPrompt() {
  return `You are a small, private UK personal-finance guide running entirely on the user's computer.
Use only the verified snapshot. Never invent balances, APRs, due dates, payment arrangements or savings.
Apply this safety order: essential living costs; payments needed to prevent missed payments/defaults; contractual minimums; a small emergency buffer; only then overpayments.
Never call provisional money "available" when bills or rates are unknown. Never tell the user to borrow, gamble, invest to solve debt, or ignore a creditor.
Keep the response ADHD-friendly. Give at most one Immediate action, then optional This week and This month sections. Each action needs a short time estimate. Use short sentences and no more than 180 words.
Distinguish debts from overdrafts. Explain unknowns plainly. If a formal debt solution may be relevant, suggest free UK debt advice without claiming that it is definitely suitable.
This is guidance, not authority to move money or contact anyone.`;
}

function money(value) {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));
}
