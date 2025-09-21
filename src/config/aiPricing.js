// Centralized AI model pricing and budgets
// Prices are USD per 1,000 tokens unless stated otherwise

const MODEL_PRICING_PER_1K = {
	'claude-opus-4-1-20250805': { input: 0.015, output: 0.075 },
	'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
	'claude-3-5-haiku-20241022': { input: 0.0001, output: 0.0005 }
};

function getPricingForModel(model) {
	return MODEL_PRICING_PER_1K[model] || { input: 0.003, output: 0.015 };
}

function calculateCostUsd(model, inputTokens, outputTokens) {
	const p = getPricingForModel(model);
	const inCost = (inputTokens / 1000) * p.input;
	const outCost = (outputTokens / 1000) * p.output;
	return { inputCostUsd: inCost, outputCostUsd: outCost, totalUsd: inCost + outCost };
}

const DEFAULT_BUDGET_USD = Number(process.env.AI_MONTHLY_BUDGET || 500);

module.exports = {
	MODEL_PRICING_PER_1K,
	getPricingForModel,
	calculateCostUsd,
	DEFAULT_BUDGET_USD
};


