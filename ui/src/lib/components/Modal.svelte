<script>
	export let open = false;
	export let title = '';
	export let subtitle = '';
	export let ariaLabel = 'Dialog';
	export let closeOnBackdrop = true;
	export let closeOnEscape = true;
	export let showCloseButton = true;
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
			{#if showCloseButton}
				<button
					type="button"
					class="modal-close-button"
					on:click={onClose}
					aria-label="Close dialog"
					title="Close"
				>
					<span aria-hidden="true">&times;</span>
				</button>
			{/if}
			{#if title}
				<h3 class="modal-title">{title}</h3>
			{/if}
			{#if subtitle}
				<p class="modal-subtitle modal-subtitle-with-close">{subtitle}</p>
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

	.modal-close-button {
		position: absolute;
		top: 10px;
		right: 10px;
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1px solid #4e5f74;
		border-radius: 999px;
		background: rgba(18, 24, 33, 0.92);
		color: #e8efff;
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		z-index: 2;
	}

	.modal-close-button:hover {
		background: rgba(28, 37, 50, 0.95);
		border-color: #6b809a;
	}

	.modal-close-button:focus-visible {
		outline: 2px solid rgba(106, 167, 133, 0.72);
		outline-offset: 1px;
	}

	.modal-title,
	.modal-subtitle-with-close {
		padding-right: 42px;
	}
</style>
