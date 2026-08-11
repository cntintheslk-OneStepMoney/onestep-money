import { recordAutomationHistoryOutcome } from './automation-history.js';
import { runStoredAutomationRules } from './automation-rules.js';

export async function runStoredAutomationRulesWithHistory(state, options = {}) {
  const beforeState = structuredClone(state || {});
  const run = await runStoredAutomationRules(state, options);
  let current = run.state;
  let historyChanged = false;

  for (const result of run.results || []) {
    const recorded = recordAutomationHistoryOutcome(current, {
      beforeState,
      proposal: proposalForHistory(current, result),
      result,
      now: options.now
    });
    current = recorded.state;
    historyChanged ||= recorded.changed;
  }

  return {
    ...run,
    state: current,
    historyChanged,
    changed: Boolean(run.changed || historyChanged)
  };
}

function proposalForHistory(state, result) {
  if (!result?.executionId) return null;
  const rule = (state?.automation?.rules || []).find((item) => item.id === result.ruleId);
  const payload = result.actionType === 'add_local_tag' && rule?.action?.type === 'add_tag'
    ? { tag: rule.action.value }
    : null;
  return {
    executionId: result.executionId,
    ruleId: result.ruleId,
    source: { type: result.sourceType, id: result.sourceId },
    action: { type: result.actionType, payload }
  };
}
