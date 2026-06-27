<script>
	import Modal from '$lib/components/Modal.svelte';

	export let open = false;
	export let scripts = [];
	export let workflow = { version: 1, nodes: [], links: [] };
	export let onClose = () => {};
	export let onSave = () => {};

	let nodes = [];
	let links = [];
	let selectedSource = '';
	let drag = null;

	$: if (open) {
		nodes = (workflow?.nodes || []).map((node) => ({ ...node }));
		links = (workflow?.links || []).map((link) => ({ ...link }));
	}

	function scriptNameForPath(scriptPath) {
		const script = scripts.find((candidate) => candidate.path === scriptPath);
		if (!script) {
			return scriptPath || 'Script';
		}
		return String(script.name || 'Script').replace(/\.(ts|js)$/i, '');
	}

	function addNode(scriptPath) {
		const id = `node_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
		const index = nodes.length;
		nodes = [
			...nodes,
			{
				id,
				scriptPath,
				name: scriptNameForPath(scriptPath),
				x: 40 + (index % 3) * 240,
				y: 40 + Math.floor(index / 3) * 140,
				trigger: 'manual',
			},
		];
	}

	function beginDrag(event, nodeId) {
		const node = nodes.find((candidate) => candidate.id === nodeId);
		if (!node) {
			return;
		}
		drag = {
			nodeId,
			startX: event.clientX,
			startY: event.clientY,
			originX: Number(node.x || 0),
			originY: Number(node.y || 0),
		};
	}

	function onMouseMove(event) {
		if (!drag) {
			return;
		}
		const dx = event.clientX - drag.startX;
		const dy = event.clientY - drag.startY;
		nodes = nodes.map((node) => {
			if (node.id !== drag.nodeId) {
				return node;
			}
			return {
				...node,
				x: Math.max(8, drag.originX + dx),
				y: Math.max(8, drag.originY + dy),
			};
		});
	}

	function endDrag() {
		drag = null;
	}

	function centerForNode(nodeId, side) {
		const node = nodes.find((candidate) => candidate.id === nodeId);
		if (!node) {
			return { x: 0, y: 0 };
		}
		const width = 220;
		const height = 110;
		return {
			x: side === 'right' ? node.x + width : node.x,
			y: node.y + height / 2,
		};
	}

	function pathForLink(link) {
		const from = centerForNode(link.from, 'right');
		const to = centerForNode(link.to, 'left');
		const dx = Math.max(40, (to.x - from.x) * 0.45);
		return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
	}

	function startConnect(nodeId) {
		selectedSource = nodeId;
	}

	function connectTo(nodeId) {
		if (!selectedSource || selectedSource === nodeId) {
			return;
		}
		const exists = links.some((link) => link.from === selectedSource && link.to === nodeId);
		if (exists) {
			selectedSource = '';
			return;
		}
		const id = `link_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
		links = [
			...links,
			{
				id,
				from: selectedSource,
				to: nodeId,
				trigger: 'on-success',
			},
		];
		selectedSource = '';
	}

	function removeNode(nodeId) {
		nodes = nodes.filter((node) => node.id !== nodeId);
		links = links.filter((link) => link.from !== nodeId && link.to !== nodeId);
		if (selectedSource === nodeId) {
			selectedSource = '';
		}
	}

	function removeLink(linkId) {
		links = links.filter((link) => link.id !== linkId);
	}

	function updateNodeTrigger(nodeId, value) {
		nodes = nodes.map((node) => (node.id === nodeId ? { ...node, trigger: value } : node));
	}

	function updateLinkTrigger(linkId, value) {
		links = links.map((link) => (link.id === linkId ? { ...link, trigger: value } : link));
	}

	function saveNow() {
		onSave({
			version: 1,
			nodes: nodes.map((node) => ({
				id: node.id,
				scriptPath: node.scriptPath,
				name: node.name,
				x: Number(node.x || 0),
				y: Number(node.y || 0),
				trigger: node.trigger || 'manual',
			})),
			links: links.map((link) => ({
				id: link.id,
				from: link.from,
				to: link.to,
				trigger: link.trigger || 'on-success',
			})),
		});
	}
</script>

<Modal
	open={open}
	ariaLabel="Workflow editor"
	closeOnBackdrop={false}
	closeOnEscape={false}
	showActions={false}
	backdropClass="workflow-overlay"
	cardClass="workflow-shell"
	onClose={onClose}
	onBackdropMouseMove={onMouseMove}
	onBackdropMouseUp={endDrag}
	onBackdropMouseLeave={endDrag}
>
	<div class="workflow-header">
		<h2><i class="fa-solid fa-diagram-project me-2"></i>Workflow Editor</h2>
		<div class="workflow-header-actions">
			<button class="btn-secondary" on:click={onClose}>Close</button>
			<button class="btn-primary" on:click={saveNow}>Save</button>
		</div>
	</div>
	<div class="workflow-body">
		<aside class="workflow-sidebar">
			<h3>Scripts</h3>
			{#if scripts.length === 0}
				<div class="workflow-empty">No scripts loaded</div>
			{:else}
				{#each scripts as script}
					<button class="workflow-script-btn" on:click={() => addNode(script.path)}>
						<i class="fa-regular fa-square-plus me-2"></i>{scriptNameForPath(script.path)}
					</button>
				{/each}
			{/if}
		</aside>
		<div class="workflow-canvas-wrap">
			<svg class="workflow-links" viewBox="0 0 1600 900" preserveAspectRatio="none">
				<defs>
					<marker id="arrow-head" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
						<polygon points="0 0, 10 3.5, 0 7" fill="#8db5ff"></polygon>
					</marker>
				</defs>
				{#each links as link}
					<path d={pathForLink(link)} class="workflow-link" marker-end="url(#arrow-head)"></path>
				{/each}
			</svg>
			<div class="workflow-canvas">
				{#each nodes as node}
					<div class="workflow-node" style={`left:${node.x}px; top:${node.y}px;`}>
						<button type="button" class="workflow-node-title" on:mousedown={(event) => beginDrag(event, node.id)}>
							<i class="fa-solid fa-file-code me-2"></i>{node.name}
						</button>
						<div class="workflow-node-meta">{node.scriptPath}</div>
						<label class="workflow-node-label" for={`node-trigger-${node.id}`}>Trigger</label>
						<select id={`node-trigger-${node.id}`} value={node.trigger} on:change={(event) => updateNodeTrigger(node.id, event.currentTarget.value)}>
							<option value="manual">manual</option>
							<option value="schedule">schedule</option>
							<option value="event">event</option>
							<option value="watch">watch</option>
						</select>
						<div class="workflow-node-actions">
							<button class="btn-secondary" on:click={() => startConnect(node.id)}>
								{selectedSource === node.id ? 'Connecting...' : 'Connect from'}
							</button>
							<button class="btn-secondary" on:click={() => connectTo(node.id)}>Connect to</button>
							<button class="btn-secondary" on:click={() => removeNode(node.id)}>Delete</button>
						</div>
					</div>
				{/each}
			</div>
		</div>
		<aside class="workflow-sidebar">
			<h3>Links</h3>
			{#if links.length === 0}
				<div class="workflow-empty">No links yet</div>
			{:else}
				{#each links as link}
					<div class="workflow-link-item">
						<div>{(nodes.find((n) => n.id === link.from)?.name || link.from)} → {(nodes.find((n) => n.id === link.to)?.name || link.to)}</div>
						<select value={link.trigger} on:change={(event) => updateLinkTrigger(link.id, event.currentTarget.value)}>
							<option value="on-success">on-success</option>
							<option value="on-failure">on-failure</option>
							<option value="always">always</option>
						</select>
						<button class="btn-secondary" on:click={() => removeLink(link.id)}>Remove</button>
					</div>
				{/each}
			{/if}
		</aside>
	</div>
</Modal>

<style>
	.workflow-overlay {
		position: fixed;
		inset: 0;
		z-index: 140;
		background: rgba(7, 11, 18, 0.72);
		backdrop-filter: blur(4px);
		padding: 14px;
	}
	.workflow-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		border: 1px solid #3a4657;
		border-radius: 14px;
		overflow: hidden;
		background: linear-gradient(165deg, #141b25, #121922);
	}
	.workflow-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 14px;
		border-bottom: 1px solid #364254;
		background: linear-gradient(180deg, rgba(35, 45, 60, 0.95), rgba(26, 34, 47, 0.92));
	}
	.workflow-header h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 0.3px;
	}
	.workflow-header-actions {
		display: flex;
		gap: 8px;
	}
	.workflow-body {
		min-height: 0;
		flex: 1;
		display: grid;
		grid-template-columns: 250px 1fr 290px;
	}
	.workflow-sidebar {
		padding: 12px;
		border-right: 1px solid #313c4c;
		overflow: auto;
	}
	.workflow-body .workflow-sidebar:last-child {
		border-left: 1px solid #313c4c;
		border-right: 0;
	}
	.workflow-sidebar h3 {
		margin: 0 0 10px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #9fb0c8;
	}
	.workflow-script-btn {
		width: 100%;
		display: flex;
		align-items: center;
		text-align: left;
		margin-bottom: 8px;
		border-radius: 10px;
		padding: 8px 9px;
		border: 1px solid #3e4d62;
		background: #243041;
		color: #e6eefb;
	}
	.workflow-empty {
		font-size: 12px;
		color: #90a0b7;
		padding: 10px;
		border: 1px dashed #44536b;
		border-radius: 10px;
	}
	.workflow-canvas-wrap {
		position: relative;
		overflow: auto;
		background-image:
			linear-gradient(rgba(114, 139, 176, 0.15) 1px, transparent 1px),
			linear-gradient(90deg, rgba(114, 139, 176, 0.15) 1px, transparent 1px);
		background-size: 24px 24px;
	}
	.workflow-links {
		position: absolute;
		inset: 0;
		width: 1600px;
		height: 900px;
		pointer-events: none;
	}
	.workflow-link {
		fill: none;
		stroke: #8db5ff;
		stroke-width: 2;
		opacity: 0.9;
	}
	.workflow-canvas {
		position: relative;
		width: 1600px;
		height: 900px;
	}
	.workflow-node {
		position: absolute;
		width: 220px;
		padding: 10px;
		border-radius: 12px;
		border: 1px solid #476181;
		background: linear-gradient(170deg, #253548, #203042);
		box-shadow: 0 14px 22px rgba(0, 0, 0, 0.32);
	}
	.workflow-node-title {
		display: block;
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		font-size: 12px;
		font-weight: 700;
		margin-bottom: 8px;
		cursor: move;
		user-select: none;
	}
	.workflow-node-meta {
		font-size: 10px;
		color: #90a3bf;
		margin-bottom: 8px;
		word-break: break-all;
	}
	.workflow-node-label {
		display: block;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.45px;
		color: #a7b8cf;
		margin-bottom: 5px;
	}
	.workflow-node select,
	.workflow-link-item select {
		width: 100%;
		border: 1px solid #3e526e;
		border-radius: 8px;
		background: #101824;
		color: #dcebff;
		padding: 6px 7px;
		margin-bottom: 8px;
	}
	.workflow-node-actions {
		display: grid;
		grid-template-columns: 1fr;
		gap: 6px;
	}
	.workflow-link-item {
		border: 1px solid #3d4d62;
		border-radius: 10px;
		padding: 8px;
		margin-bottom: 8px;
		background: #202d3d;
		font-size: 12px;
	}
	@media (max-width: 1200px) {
		.workflow-body {
			grid-template-columns: 1fr;
			grid-template-rows: 190px 1fr 220px;
		}
		.workflow-sidebar {
			border-right: 0;
			border-bottom: 1px solid #313c4c;
		}
		.workflow-body .workflow-sidebar:last-child {
			border-left: 0;
			border-top: 1px solid #313c4c;
		}
	}
</style>
