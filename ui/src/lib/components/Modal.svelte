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

	$: backdropRole = closeOnBackdrop ? 'button' : 'presentation';
	$: backdropTabIndex = closeOnBackdrop ? 0 : -1;

	function handleBackdropClick() {
		if (closeOnBackdrop) {
			onClose();
		}
	}

	function handleBackdropKeydown(event) {
		if (!closeOnBackdrop) {
			return;
		}

		if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onClose();
		}
	}

	function handleCardKeydown(event) {
		if (!closeOnEscape) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}
</script>

{#if open}
	<div
		class={backdropClass}
		role={backdropRole}
		tabindex={backdropTabIndex}
		on:click={handleBackdropClick}
		on:keydown={handleBackdropKeydown}
		on:mousemove={onBackdropMouseMove}
		on:mouseup={onBackdropMouseUp}
		on:mouseleave={onBackdropMouseLeave}
	>
		<div
			class={cardClass}
			role="dialog"
			aria-modal="true"
			aria-label={ariaLabel}
			tabindex="-1"
			on:click|stopPropagation
			on:keydown={handleCardKeydown}
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
