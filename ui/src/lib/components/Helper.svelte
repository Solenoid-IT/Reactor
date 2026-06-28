<script>
	export let ariaLabel = 'Help';
</script>

<span class="helper" tabindex="0" aria-label={ariaLabel}>
	<i class="fa-solid fa-circle-info" aria-hidden="true"></i>
	<span class="helper-tooltip" role="tooltip">
		<slot />
	</span>
</span>

<style>
	.helper {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-left: 8px;
		cursor: help;
		color: rgba(255, 255, 255, 0.65);
		transition: color 0.2s ease;
	}

	.helper:hover,
	.helper:focus-visible {
		color: rgba(255, 255, 255, 0.95);
		outline: none;
	}

	.helper-tooltip {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 10px);
		transform: translateX(-50%);
		z-index: 30;
		min-width: 220px;
		max-width: 300px;
		padding: 8px 10px;
		border-radius: 8px;
		font-size: 0.76rem;
		line-height: 1.35;
		color: #f7f7f7;
		background: rgba(18, 24, 30, 0.96);
		border: 1px solid rgba(255, 255, 255, 0.12);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		transition: opacity 0.15s ease, visibility 0.15s ease;
	}

	.helper-tooltip::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 100%;
		transform: translateX(-50%);
		border-width: 6px;
		border-style: solid;
		border-color: rgba(18, 24, 30, 0.96) transparent transparent transparent;
	}

	.helper:hover .helper-tooltip,
	.helper:focus-visible .helper-tooltip {
		opacity: 1;
		visibility: visible;
	}
</style>
