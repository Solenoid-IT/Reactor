<script>
	import { onMount } from 'svelte';

	let templateOpen = false;
	let logOpen = false;

	export let onRefresh = () => {};
	export let onOpenFolder = () => {};
	export let onOpenSettings = () => {};
	export let onOpenNetworkView = () => {};
	export let onOpenGlobalLog = () => {};
	export let onClearGlobalLog = () => {};
	export let onCreateBlank = () => {};
	export let onCreateSchedule = () => {};
	export let onCreateEvent = () => {};
	export let onCreateWatch = () => {};
	export let exchangeStatus = { level: 'red', label: 'EXCHANGE inactive', title: 'EXCHANGE is not connected' };
	export let p2pStatus = { level: 'red', label: 'P2P inactive', title: 'P2P is not connected' };

	function handleWindowClick(event) {
		const picker = event.target && event.target.closest ? event.target.closest('.template-picker') : null;
		const logPicker = event.target && event.target.closest ? event.target.closest('.log-picker') : null;
		if (!picker) {
			templateOpen = false;
		}
		if (!logPicker) {
			logOpen = false;
		}
	}

	onMount(() => {
		window.addEventListener('click', handleWindowClick);
		return () => window.removeEventListener('click', handleWindowClick);
	});
</script>

<header class="header">
	<div class="title">
		<img class="logo" src="/logo.jpg" alt="Reactor logo" />
		<div class="title-copy">
			<h1>Reactor</h1>
			<p>Distribute your workflow</p>
		</div>
	</div>
	<div class="connection-status" aria-label="Connection status">
		<div class="status-chip" title={exchangeStatus?.title || exchangeStatus?.label || 'EXCHANGE status'}>
			<span class={`status-dot status-${exchangeStatus?.level || 'red'}`}></span>
			<span class="status-text">{exchangeStatus?.label || 'EXCHANGE inactive'}</span>
		</div>
		<div class="status-chip" title={p2pStatus?.title || p2pStatus?.label || 'P2P status'}>
			<span class={`status-dot status-${p2pStatus?.level || 'red'}`}></span>
			<span class="status-text">{p2pStatus?.label || 'P2P inactive'}</span>
		</div>
	</div>
	<div class="actions">
		<div class="template-picker" class:open={templateOpen}>
			<button type="button" class="btn-primary" on:click={() => (templateOpen = !templateOpen)} title="create new endpoint">+</button>
			<div class="template-menu" aria-hidden={!templateOpen}>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateBlank(); }}><i class="fa-regular fa-file"></i><span>Blank</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateSchedule(); }}><i class="fa-solid fa-clock-rotate-left"></i><span>Schedule</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateEvent(); }}><i class="fa-solid fa-bolt"></i><span>Event</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateWatch(); }}><i class="fa-solid fa-eye"></i><span>Watch</span></button>
			</div>
		</div>

		<button type="button" class="btn-secondary" on:click={onOpenSettings} title="settings"><i class="fa-solid fa-cog"></i></button>

		<div class="log-picker" class:open={logOpen}>
			<button type="button" class="btn-secondary" on:click={() => (logOpen = !logOpen)} title="log actions"><i class="fa-solid fa-list"></i></button>
			<div class="log-menu" aria-hidden={!logOpen}>
				<button type="button" class="log-menu-item" on:click={() => { logOpen = false; onOpenGlobalLog(); }}><i class="fa-solid fa-magnifying-glass"></i><span>View</span></button>
				<button type="button" class="log-menu-item danger" on:click={() => { logOpen = false; onClearGlobalLog(); }}><i class="fa-solid fa-trash"></i><span>Clear</span></button>
			</div>
		</div>

		<button type="button" class="btn-secondary" on:click={onOpenNetworkView} title="view node network"><i class="fa-solid fa-diagram-project"></i></button>

		<button type="button" class="btn-secondary icon-button" on:click={onRefresh} title="refresh endpoints" aria-label="Refresh endpoints"><i class="fa-solid fa-rotate-right"></i></button>
		<button type="button" class="btn-secondary icon-button" on:click={onOpenFolder} title="open endpoints folder" aria-label="Open endpoints folder"><i class="fa-regular fa-folder-open"></i></button>
	</div>
</header>

<style>
	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		min-width: 0;
	}

	.connection-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-left: auto;
	}

	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.42rem 0.7rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.08);
		color: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
	}

	.status-dot {
		width: 0.7rem;
		height: 0.7rem;
		border-radius: 999px;
		flex: 0 0 auto;
		box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.18) inset;
	}

	.status-red {
		background: #ef4444;
	}

	.status-yellow {
		background: #f59e0b;
	}

	.status-green {
		background: #22c55e;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.actions > button,
	.actions > .template-picker > button,
	.actions > .log-picker > button {
		width: 42px;
		height: 42px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	.actions > button i,
	.actions > .log-picker > button i {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		line-height: 1;
	}

	@media (max-width: 900px) {
		.connection-status {
			order: 3;
			margin-left: 0;
		}
	}

	@media (max-width: 720px) {
		.status-chip {
			font-size: 0.72rem;
			padding: 0.35rem 0.62rem;
		}
	}
</style>
