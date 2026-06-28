<script>
	export let open = false;
	export let title = '';
	export let subtitle = '';
	export let ariaLabel = 'Dialog';
	export let closeOnBackdrop = true;
	export let closeOnEscape = true;
	export let backdropClass = 'modal-backdrop';
	export let cardClass = 'modal-card';
	export let showActions = true;
	export let onClose = () => {};
	export let onBackdropMouseMove = () => {};
	export let onBackdropMouseUp = () => {};
	export let onBackdropMouseLeave = () => {};

	function handleBackdropClick() {
		if (closeOnBackdrop) {
			onClose();
		}
	}

	function handleWindowKeydown(event) {
		if (!open || !closeOnEscape) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

<svelte:window on:keydown={handleWindowKeydown} />

{#if open}
	<div
		class={backdropClass}
		role="presentation"
		on:mousemove={onBackdropMouseMove}
		on:mouseup={onBackdropMouseUp}
		on:mouseleave={onBackdropMouseLeave}
	>
		{#if closeOnBackdrop}
			<button
				type="button"
				class="modal-backdrop-hitbox"
				aria-label="Close dialog"
				on:click={handleBackdropClick}
			></button>
		{/if}
		<div
			class={cardClass}
			style="position: relative; z-index: 1;"
			role="dialog"
			aria-modal="true"
			aria-label={ariaLabel}
			tabindex="-1"
		>
			{#if title}
				<h3>{title}</h3>
			{/if}
			{#if subtitle}
				<p class="modal-subtitle">{subtitle}</p>
			{/if}
			<slot />
			{#if showActions}
				<div class="modal-actions">
					<slot name="actions" />
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.modal-backdrop-hitbox {
		position: absolute;
		inset: 0;
		z-index: 0;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
	}
</style>
