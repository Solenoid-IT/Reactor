<script>
	export let endpoints = [];
	export let selectedIndex = -1;
	export let onSelect = () => {};
	export let onToggleState = () => {};
	export let onToggleDebug = () => {};
	export let onToggleMutex = () => {};
	export let onRun = () => {};
	export let onOpen = () => {};
	export let onQuickOpenHover = () => {};
	export let onRename = () => {};
	export let onDelete = () => {};
	export let onOpenLog = () => {};
	export let onClearLog = () => {};
	export let onCopyId = () => {};
	export let onReorder = () => {};

	let draggingIndex = -1;

	function reorderEndpoints(fromIndex, toIndex) {
		if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
			return;
		}
		if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
			return;
		}
		onReorder(fromIndex, toIndex);
	}

	function endpointTags(endpoint) {
		const tags = [];
		tags.push({ label: endpoint?.enabled ? 'enabled' : 'disabled', cls: endpoint?.enabled ? 'ok' : '' });
		tags.push({ label: endpoint?.mutex ? 'mutex' : 'no mutex', cls: endpoint?.mutex ? 'mutex' : '' });
		tags.push({ label: endpoint?.schedule || 'no schedule', cls: endpoint?.schedule ? 'warn' : '' });
		tags.push({ label: endpoint?.watch?.length ? `watch (${endpoint.watch.length})` : 'no watch', cls: endpoint?.watch?.length ? 'watch' : '' });
		return tags;
	}

	function endpointDisplayName(endpoint) {
		const rawName = String(endpoint?.name || '').trim();
		return rawName ? rawName.replace(/\.(ts|js)$/i, '') : 'Unnamed endpoint';
	}
</script>

<div class="file-list">
	{#if endpoints.length === 0}
		<div class="empty">No endpoints found</div>
	{:else}
		{#each endpoints as endpoint, index}
			<div
				class:selected={index === selectedIndex}
				class="file-item"
				draggable="true"
				on:dragstart={() => {
					draggingIndex = index;
				}}
				on:dragover|preventDefault={() => {}}
				on:drop|preventDefault={() => {
					reorderEndpoints(draggingIndex, index);
					draggingIndex = -1;
				}}
				on:dragend={() => {
					draggingIndex = -1;
				}}
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
						<div class="file-name-row">
								<div class="file-name"><span class="file-name-label">{endpointDisplayName(endpoint)}</span></div>
							<button
								class={`debug-icon-toggle ${endpoint.debug ? 'debug-on' : 'debug-off'}`}
								title={endpoint.debug ? 'Disable debug' : 'Enable debug'}
								aria-label={endpoint.debug ? 'Disable debug' : 'Enable debug'}
								on:click|stopPropagation={() => onToggleDebug(index)}
							>
								<i class="fa-solid fa-bug" aria-hidden="true"></i>
							</button>
						</div>
						<div class="file-tags">
							{#each endpointTags(endpoint) as tag}
								<span class={`tag ${tag.cls}`}>{tag.label}</span>
							{/each}
						</div>
					</div>
					<div class="toggle-stack">
						<button class={`switch-toggle ${endpoint.enabled ? 'state-on' : 'state-off'}`} on:click|stopPropagation={() => onToggleState(index)}>
							<span class="switch-label">{endpoint.enabled ? 'Enabled' : 'Disabled'}</span>
							<span class="switch-knob" aria-hidden="true"></span>
						</button>
						<button class={`switch-toggle ${endpoint.mutex ? 'mutex-on' : 'mutex-off'}`} on:click|stopPropagation={() => onToggleMutex(index)}>
							<span class="switch-label">Mutex</span>
							<span class="switch-knob" aria-hidden="true"></span>
						</button>
					</div>
				</div>
				<div class="item-reorder-controls">
					<span class="item-reorder-label">Order</span>
					<div class="item-reorder-buttons">
						<button
							class="item-reorder-btn"
							on:click|stopPropagation={() => reorderEndpoints(index, index - 1)}
							disabled={index === 0}
							aria-label="Move endpoint up"
						><i class="fa-solid fa-arrow-up"></i></button>
						<button
							class="item-reorder-btn"
							on:click|stopPropagation={() => reorderEndpoints(index, index + 1)}
							disabled={index >= endpoints.length - 1}
							aria-label="Move endpoint down"
						><i class="fa-solid fa-arrow-down"></i></button>
					</div>
				</div>
				<div class="item-actions">
					<button
						class="item-action-btn"
						on:mouseenter|stopPropagation={() => onQuickOpenHover(index)}
						on:focus|stopPropagation={() => onQuickOpenHover(index)}
						on:click|stopPropagation={() => onOpen(index)}
					><i class="fa-solid fa-code"></i><span class="item-action-label">Open</span></button>
					<button class="item-action-btn" on:click|stopPropagation={() => onRename(index)}><i class="fa-solid fa-pen"></i><span class="item-action-label">Rename</span></button>
					{#if endpoint.endpointId}
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
