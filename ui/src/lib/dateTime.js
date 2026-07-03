function pad2(value) {
	return String(value).padStart(2, '0');
}

export const UI_DATE_TIME_CONVENTION = Object.freeze({
	pattern: 'Y-m-d H:i:s',
	timezone: 'local',
	example: '2026-07-03 14:05:09',
});

export function formatUiDateTime(value, fallback = '-') {
	if (value === null || value === undefined) {
		return fallback;
	}

	const raw = String(value).trim();
	if (!raw) {
		return fallback;
	}

	const parsedMs = Date.parse(raw);
	if (!Number.isFinite(parsedMs)) {
		return raw;
	}

	const date = new Date(parsedMs);
	const year = date.getFullYear();
	const month = pad2(date.getMonth() + 1);
	const day = pad2(date.getDate());
	const hours = pad2(date.getHours());
	const minutes = pad2(date.getMinutes());
	const seconds = pad2(date.getSeconds());

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
