<script>
	export let value = '';
	export let name = '';
	export let placeholder = '';
	export let dataType = 'string';
	export let required = false;
	export let disabled = false;
	export let autocomplete = 'current-password';
	export let ariaLabel = 'Toggle password visibility';

	let visible = false;

	function toggleVisibility() {
		visible = !visible;
	}
</script>

<div class="input-group password-field-group">
	<input
		type={visible ? 'text' : 'password'}
		class="input password-field-input"
		{name}
		{placeholder}
		data-type={dataType}
		data-required={required ? 'true' : 'false'}
		{disabled}
		{autocomplete}
		bind:value
	/>
	<div class="input-group-append password-field-append">
		<button
			type="button"
			class="btn-secondary password-field-toggle"
			on:click={toggleVisibility}
			aria-label={ariaLabel}
			title={visible ? 'Hide password' : 'Show password'}
		>
			<i class={visible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye'}></i>
		</button>
	</div>
</div>

<style>
	.password-field-group {
		display: flex;
		align-items: stretch;
		flex-wrap: nowrap;
		gap: 0;
		width: 100%;
	}

	.password-field-input {
		flex: 1 1 auto;
		width: 1%;
		min-width: 0;
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}

	.password-field-append {
		display: flex;
		align-items: stretch;
	}

	.password-field-toggle {
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		min-width: 42px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
</style>
