/**
 * Parses schedule expressions in the format "EVERY N SECOND|MINUTE|HOUR"
 * Returns milliseconds interval, or null if invalid
 */
function parseScheduleExpression(expression) {
	if (!expression) {
		return null;
	}

	const match = expression
		.trim()
		.match(/^EVERY\s+(\d+)\s+(SECOND|SECONDS|MINUTE|MINUTES|HOUR|HOURS)$/i);

	if (!match) {
		return null;
	}

	const amount = Number(match[1]);
	const unit = match[2].toUpperCase();

	if (amount <= 0) {
		return null;
	}

	const multipliers = {
		SECOND: 1000,
		SECONDS: 1000,
		MINUTE: 60 * 1000,
		MINUTES: 60 * 1000,
		HOUR: 60 * 60 * 1000,
		HOURS: 60 * 60 * 1000,
	};

	const multiplier = multipliers[unit];
	if (!multiplier) {
		return null;
	}

	return amount * multiplier;
}

module.exports = { parseScheduleExpression };
