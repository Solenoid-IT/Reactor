<script>
	import { onMount } from 'svelte';

	let templateOpen = false;
	let logOpen = false;

	export let onRefresh = () => {};
	export let onOpenFolder = () => {};
	export let onPickProgram = () => {};
	export let onOpenWorkflow = () => {};
	export let onOpenGlobalLog = () => {};
	export let onClearGlobalLog = () => {};
	export let onCreateBlank = () => {};
	export let onCreateSchedule = () => {};
	export let onCreateEvent = () => {};
	export let onCreateWatch = () => {};

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
			<p>Automate your nodes</p>
		</div>
	</div>
	<div class="actions">
		<div class="template-picker" class:open={templateOpen}>
			<button type="button" class="btn-primary" on:click={() => (templateOpen = !templateOpen)} title="create new script">+</button>
			<div class="template-menu" aria-hidden={!templateOpen}>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateBlank(); }}><i class="fa-regular fa-file"></i><span>Blank</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateSchedule(); }}><i class="fa-solid fa-clock-rotate-left"></i><span>Schedule</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateEvent(); }}><i class="fa-solid fa-bolt"></i><span>Event</span></button>
				<button type="button" class="template-menu-item" on:click={() => { templateOpen = false; onCreateWatch(); }}><i class="fa-solid fa-eye"></i><span>Watch</span></button>
			</div>
		</div>
		<button type="button" class="btn-secondary icon-button" on:click={onRefresh} title="refresh scripts" aria-label="Refresh scripts"><i class="fa-solid fa-rotate-right"></i></button>
		<button type="button" class="btn-secondary icon-button" on:click={onOpenFolder} title="open project folder" aria-label="Open project folder"><i class="fa-regular fa-folder-open"></i></button>
		<button type="button" class="btn-secondary" on:click={onPickProgram}><i class="fa-solid fa-gear"></i><span class="ms-2">Set Default Program</span></button>
		<button type="button" class="btn-secondary" on:click={onOpenWorkflow}><i class="fa-solid fa-diagram-project"></i><span class="ms-2">Open Workflow</span></button>
		<div class="log-picker" class:open={logOpen}>
			<button type="button" class="btn-secondary" on:click={() => (logOpen = !logOpen)} title="log actions"><i class="fa-solid fa-list"></i><span class="ms-2">LOG</span></button>
			<div class="log-menu" aria-hidden={!logOpen}>
				<button type="button" class="log-menu-item" on:click={() => { logOpen = false; onOpenGlobalLog(); }}><i class="fa-solid fa-magnifying-glass"></i><span>View</span></button>
				<button type="button" class="log-menu-item danger" on:click={() => { logOpen = false; onClearGlobalLog(); }}><i class="fa-solid fa-trash"></i><span>Clear</span></button>
			</div>
		</div>
	</div>
</header>
