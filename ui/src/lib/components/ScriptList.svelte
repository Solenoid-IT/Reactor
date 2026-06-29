<script>
	export let scripts = [];
	export let selectedIndex = -1;
	export let onSelect = () => {};
	export let onToggleState = () => {};
	export let onToggleMutex = () => {};
	export let onRun = () => {};
	export let onOpen = () => {};
	export let onQuickOpen = () => {};
	export let onQuickOpenHover = () => {};
	export let onRename = () => {};
	export let onDelete = () => {};
	export let onOpenLog = () => {};
	export let onClearLog = () => {};
	export let onCopyId = () => {};

	function scriptTags(script) {
		const tags = [];
		tags.push({ label: script?.enabled ? 'enabled' : 'disabled', cls: script?.enabled ? 'ok' : '' });
		tags.push({ label: script?.mutex ? 'mutex' : 'no mutex', cls: script?.mutex ? 'mutex' : '' });
		tags.push({ label: script?.schedule || 'no schedule', cls: script?.schedule ? 'warn' : '' });
		tags.push({ label: script?.watch?.length ? `watch (${script.watch.length})` : 'no watch', cls: script?.watch?.length ? 'watch' : '' });
		return tags;
	}
</script>

<div class="file-list">
	{#if scripts.length === 0}
		<div class="empty">No scripts found</div>
	{:else}
		{#each scripts as script, index}
			<div
				class:selected={index === selectedIndex}
				class="file-item"
				role="button"
				tabindex="0"
				on:click={() => onSelect(index)}
				on:keydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						onSelect(index);
					}
				}}
			>
				<div class="file-header">
					<div class="file-header-main">
						<div class="file-name"><span class="file-name-label">{script.name.replace(/\.(ts|js)$/i, '')}</span></div>
						<div class="file-tags">
							{#each scriptTags(script) as tag}
								<span class={`tag ${tag.cls}`}>{tag.label}</span>
							{/each}
						</div>
					</div>
					<div class="toggle-stack">
						<button class={`switch-toggle ${script.enabled ? 'state-on' : 'state-off'}`} on:click|stopPropagation={() => onToggleState(index)}>
							<span class="switch-label">{script.enabled ? 'Enabled' : 'Disabled'}</span>
							<span class="switch-knob" aria-hidden="true"></span>
						</button>
						<button class={`switch-toggle ${script.mutex ? 'mutex-on' : 'mutex-off'}`} on:click|stopPropagation={() => onToggleMutex(index)}>
							<span class="switch-label">Mutex</span>
							<span class="switch-knob" aria-hidden="true"></span>
						</button>
					</div>
				</div>
				<div class="item-actions">
					<button class="item-action-btn" on:click|stopPropagation={() => onOpen(index)}><i class="fa-solid fa-code"></i><span class="item-action-label">Open</span></button>
					<button
						class="item-action-btn"
						on:mouseenter|stopPropagation={() => onQuickOpenHover(index)}
						on:focus|stopPropagation={() => onQuickOpenHover(index)}
						on:click|stopPropagation={() => onQuickOpen(index)}
					>
						<i class="fa-solid fa-laptop-code"></i><span class="item-action-label">Quick Open</span>
					</button>
					<button class="item-action-btn" on:click|stopPropagation={() => onRename(index)}><i class="fa-solid fa-pen"></i><span class="item-action-label">Rename</span></button>
					{#if script.scriptId}
						<button class="item-action-btn" on:click|stopPropagation={() => onCopyId(index)}><i class="fa-solid fa-copy"></i><span class="item-action-label">Copy ID</span></button>
					{/if}
					<button class="item-action-btn delete" on:click|stopPropagation={() => onDelete(index)}><i class="fa-solid fa-trash"></i><span class="item-action-label">Delete</span></button>
					<button class="item-action-btn test" on:click|stopPropagation={() => onRun(index)}><i class="fa-solid fa-play"></i><span class="item-action-label">Test</span></button>
					<button class="item-action-btn" on:click|stopPropagation={() => onOpenLog(index)}><i class="fa-solid fa-magnifying-glass"></i><span class="item-action-label">View Log</span></button>
					<button class="item-action-btn" on:click|stopPropagation={() => onClearLog(index)}><i class="fa-solid fa-list"></i><span class="item-action-label">Clear Log</span></button>
				</div>
			</div>
		{/each}
	{/if}
</div>
