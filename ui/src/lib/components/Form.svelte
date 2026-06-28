<script>
	import { createEventDispatcher } from 'svelte';

	const dispatch = createEventDispatcher();
	let formEl;

	function collectInputs() {
		if (!formEl) {
			return [];
		}
		return Array.from(formEl.querySelectorAll('.input'));
	}

	function clearInvalidState(input) {
		input.classList.remove('input-invalid');
	}

	function isRequired(input) {
		if (!input.dataset) {
			return false;
		}
		if (!Object.prototype.hasOwnProperty.call(input.dataset, 'required')) {
			return false;
		}
		const value = String(input.dataset.required || '').trim().toLowerCase();
		return value === '' || value === '1' || value === 'true' || value === 'yes';
	}

	function getDataType(input) {
		const rawType = String((input.dataset && input.dataset.type) || 'string').trim().toLowerCase();
		if (rawType === 'int' || rawType === 'float' || rawType === 'bool' || rawType === 'string') {
			return rawType;
		}
		return 'string';
	}

	function parseBoolean(rawValue) {
		if (typeof rawValue === 'boolean') {
			return rawValue;
		}
		const normalized = String(rawValue || '').trim().toLowerCase();
		if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
			return true;
		}
		if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === '') {
			return false;
		}
		return null;
	}

	function parseTypedValue(input, rawValue) {
		const type = getDataType(input);
		if (type === 'string') {
			return rawValue;
		}

		if (type === 'bool') {
			return parseBoolean(rawValue);
		}

		if (type === 'int') {
			if (typeof rawValue !== 'string' || !/^-?\d+$/.test(rawValue.trim())) {
				return null;
			}
			const parsedInt = Number.parseInt(rawValue, 10);
			return Number.isInteger(parsedInt) ? parsedInt : null;
		}

		if (type === 'float') {
			if (typeof rawValue !== 'string' || !/^-?\d+(\.\d+)?$/.test(rawValue.trim())) {
				return null;
			}
			const parsedFloat = Number.parseFloat(rawValue);
			return Number.isFinite(parsedFloat) ? parsedFloat : null;
		}

		return rawValue;
	}

	function getRawValue(input) {
		const type = (input.type || '').toLowerCase();
		if (type === 'checkbox') {
			return Boolean(input.checked);
		}
		if (type === 'radio') {
			if (!input.name || !input.checked) {
				return '';
			}
			return input.value;
		}
		if (input.tagName === 'SELECT' && input.multiple) {
			return Array.from(input.selectedOptions).map((option) => option.value);
		}
		return String(input.value ?? '');
	}

	function hasValue(input) {
		const rawValue = getRawValue(input);
		if (Array.isArray(rawValue)) {
			return rawValue.length > 0;
		}
		if (typeof rawValue === 'boolean') {
			return rawValue;
		}
		return String(rawValue).trim().length > 0;
	}

	function matchesRegex(input, rawValue) {
		const regexPattern = (input.dataset && input.dataset.regex) || '';
		if (!regexPattern) {
			return true;
		}

		if (Array.isArray(rawValue)) {
			return rawValue.every((value) => {
				try {
					return new RegExp(regexPattern).test(String(value));
				} catch {
					return false;
				}
			});
		}

		try {
			return new RegExp(regexPattern).test(String(rawValue));
		} catch {
			return false;
		}
	}

	function isValidByType(input, rawValue) {
		if (Array.isArray(rawValue)) {
			return rawValue.every((value) => parseTypedValue(input, String(value)) !== null);
		}
		return parseTypedValue(input, rawValue) !== null;
	}

	function isInputValid(input) {
		const rawValue = getRawValue(input);
		const required = isRequired(input);

		if (required && !hasValue(input)) {
			return false;
		}

		if (!required && !hasValue(input)) {
			return true;
		}

		if (!isValidByType(input, rawValue)) {
			return false;
		}

		if (!matchesRegex(input, rawValue)) {
			return false;
		}

		return true;
	}

	function readValue(input) {
		const rawValue = getRawValue(input);
		if (Array.isArray(rawValue)) {
			return rawValue.map((value) => {
				const parsed = parseTypedValue(input, String(value));
				return parsed === null ? value : parsed;
			});
		}

		const parsed = parseTypedValue(input, rawValue);
		return parsed === null ? rawValue : parsed;
	}

	function setNestedValue(target, dottedName, value) {
		if (!dottedName || typeof dottedName !== 'string') {
			return;
		}

		const keys = dottedName
			.split('.')
			.map((part) => part.trim())
			.filter(Boolean);

		if (keys.length === 0) {
			return;
		}

		let current = target;
		for (let index = 0; index < keys.length - 1; index += 1) {
			const key = keys[index];
			if (typeof current[key] !== 'object' || current[key] === null || Array.isArray(current[key])) {
				current[key] = {};
			}
			current = current[key];
		}

		current[keys[keys.length - 1]] = value;
	}

	export function getValues() {
		const values = {};
		const inputs = collectInputs();
		const radioNames = new Set();

		for (const input of inputs) {
			if (!input.name) {
				continue;
			}

			const type = (input.type || '').toLowerCase();
			if (type === 'radio') {
				radioNames.add(input.name);
				continue;
			}

			setNestedValue(values, input.name, readValue(input));
		}

		for (const name of radioNames) {
			const checked = formEl.querySelector(`.input[type="radio"][name="${CSS.escape(name)}"]:checked`);
			const firstRadio = formEl.querySelector(`.input[type="radio"][name="${CSS.escape(name)}"]`);
			const radioValue = checked ? readValue(checked) : (firstRadio ? readValue(firstRadio) : '');
			setNestedValue(values, name, radioValue);
		}

		return values;
	}

	export function validate() {
		const inputs = collectInputs();
		let isValid = true;
		let firstInvalidInput = null;
		const handledRadioNames = new Set();

		for (const input of inputs) {
			clearInvalidState(input);
			if ((input.type || '').toLowerCase() === 'radio' && input.name) {
				if (handledRadioNames.has(input.name)) {
					continue;
				}
				handledRadioNames.add(input.name);
				const group = inputs.filter((candidate) => (candidate.type || '').toLowerCase() === 'radio' && candidate.name === input.name);
				const groupValid = group.some((radio) => isInputValid(radio));
				if (!groupValid) {
					for (const radio of group) {
						radio.classList.add('input-invalid');
					}
					isValid = false;
					if (!firstInvalidInput) {
						firstInvalidInput = group[0];
					}
				}
				continue;
			}

			if (!isInputValid(input)) {
				input.classList.add('input-invalid');
				isValid = false;
				if (!firstInvalidInput) {
					firstInvalidInput = input;
				}
			}
		}

		if (firstInvalidInput) {
			firstInvalidInput.focus();
		}

		return isValid;
	}

	function handleInput(event) {
		const input = event.target;
		if (input && input.classList && input.classList.contains('input')) {
			if (input.checkValidity()) {
				clearInvalidState(input);
			}
		}
	}

	function handleSubmit(event) {
		event.preventDefault();
		const valid = validate();
		const values = getValues();
		dispatch('submit', { valid, values });
	}
</script>

<form bind:this={formEl} on:submit={handleSubmit} on:input={handleInput} on:change={handleInput} novalidate>
	<slot />
</form>
